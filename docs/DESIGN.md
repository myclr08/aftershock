# Aftershock: technical design

Status: draft for M0–M6. This document is the reference for implementation; when code and this
document disagree, fix one of them in the same change.

## 1. Problem and goals

In large .NET solutions a full local build plus all unit tests can take around ten minutes.
Tests often sit in two or three very large test projects, so selecting tests *per project*
(as `dotnet-affected` and similar tools do) barely helps: almost every change hits one of the
big test projects. Many teams also have a quality gate that requires, for example, 85%
coverage on new code, and developers only find out after pushing.

Aftershock is a VS Code extension that, **on save**:

1. statically finds the **test methods** affected by the change (Roslyn, method-level),
2. builds only the test projects that contain them and runs only those tests,
3. computes **new-code coverage** with the same formula SonarQube uses and shows it live,
   including "how many more lines/conditions are needed to reach the gate",
4. runs the **Sonar C# rules** of the project's quality profile locally on the saved file and
   shows issues on new code.

Priorities:

- **xUnit is the first-class test framework** (v2 and v3). NUnit and MSTest are supported too,
  and are covered by fixtures and tests.
- **Windows first**, Linux and macOS supported.
- No dependency on other VS Code extensions (no SonarQube for IDE, no C# Dev Kit
  requirement).
- Fast feedback beats completeness, but never silently: when static analysis cannot be
  trusted, Aftershock falls back to running whole test projects and says why.

## 2. Non-goals

- Writing Sonar rules. Aftershock runs SonarSource's own analyzer package.
- Depending on SonarQube for IDE or any other extension.
- Per-test dynamic coverage maps (the NCrunch/dotCover approach). This may come later.
- Replacing the CI analysis. The pull request analysis on the server stays the definitive
  result.

## 3. Repository layout

```
/extension   TypeScript VS Code extension: UI and orchestration
/analyzer    C# (.NET 8+) long-running process: Roslyn workspace, impact analysis, local rules
/samples     Fixture solutions used by analyzer tests (xUnit, NUnit, MSTest cases)
/docs        Design, analyzer CLI contract (docs/analyzer-cli.md), M0 measurement guide
/scripts     Developer and measurement scripts (scripts/measure-build.ps1)
```

## 4. Architecture

```
 VS Code
 +-------------------------------------------------------------+
 | extension (TypeScript)                                      |
 |  save listener -> debounce -> orchestrator                  |
 |    |-- analyzer client (JSON over stdio) ------------------+|
 |    |-- build/test runner (dotnet build / dotnet test)      ||
 |    |-- coverage engine (git diff + Cobertura + formula)    ||
 |    '-- Sonar client (Web API, token in SecretStorage)      ||
 |  UI: status bar, output channel, Problems, decorations     ||
 +------------------------------------------------------------|+
                                                              |
 +------------------------------------------------------------v+
 | analyzer (C#, .NET 8+)                                      |
 |  MSBuildWorkspace (warm) -> impact analysis (BFS)           |
 |  CompilationWithAnalyzers + SonarAnalyzer.CSharp (isolated) |
 +-------------------------------------------------------------+
```

### 4.1 analyzer (C#)

- Loads the solution as an `MSBuildWorkspace` using `Microsoft.Build.Locator` and
  `Microsoft.CodeAnalysis.Workspaces.MSBuild`.
  - `MSBuildLocator.RegisterDefaults()` (or a specific instance) must run before any MSBuild
    type is loaded. Keep MSBuild-touching code out of `Main`'s method body so the JIT does not
    load MSBuild types early.
  - `Microsoft.Build*` packages are referenced with `ExcludeAssets="runtime"` so the SDK's
    MSBuild is used.
  - Target `net8.0` with `RollForward=LatestMajor`: the analyzer runs on the newest installed
    runtime, so it can load MSBuild from the newest SDK, and still runs where only .NET 8 is
    installed. Roslyn packages are pinned to **5.6.0**, the newest release whose
    `Microsoft.CodeAnalysis.Workspaces.MSBuild` still ships a `net8.0` build (5.9.0 has only
    `net10.0` and `net472`). Raise the target framework and the packages together.
  - `MSBuildLocator` is queried with the solution folder as working directory, so a
    `global.json` next to the solution selects the SDK.
  - Every `WorkspaceFailed` diagnostic is logged. Load failures are never swallowed. A project
    that fails to load puts every change touching it into fallback mode (section 5.5).
- Two modes:
  1. **One-shot CLI** (built first, testable on its own):
     `analyzer impact --solution X.sln --base <git-ref> [--json]` prints the impacted tests
     and their reason chains. The contract is in [analyzer-cli.md](analyzer-cli.md).
  2. **Server mode** (M2): `analyzer serve --solution X.sln` speaks newline-delimited
     JSON-RPC 2.0 over stdio (`initialize`, `impact`, `impactSinceBase`, `reload`, `status`,
     `shutdown`/`exit`; notifications `log`, `progress`, `workspaceReloaded`; `$/cancelRequest`).
     The contract is in [analyzer-cli.md](analyzer-cli.md#server-mode-serve).
- Server mode keeps the workspace warm:
  - Every document text is pinned in memory at load (Roslyn may otherwise drop a file-backed text
    and silently re-read a newer version from disk). Saved files are read from disk and applied
    with `Solution.WithDocumentText(...)`; new files are added to the project that owns their
    folder, deleted files are removed.
  - It keeps the last analyzed text of every file (a snapshot). `impact` diffs snapshot vs disk
    with the M1 engine and advances the snapshot only when the request returns a result; files of
    cancelled or superseded requests stay pending and are included in the next `impact`.
  - `impactSinceBase` runs the CLI's git change set (by default against `git merge-base HEAD
    <target>`) on the warm workspace; it is what M4 needs for the new code of a saved file.
  - Analyses are serialized; a new `impact` cancels the running one (supersede). A request that
    has already committed its snapshots returns its result.
  - Project-level changes (build files, the solution file) are answered with their fallback and
    reload the workspace in the background. Requests keep being answered on the old workspace;
    until the reload is done, analyses add a `workspaceReloading` fallback for the dependents of
    the projects whose build files changed. After the swap, files whose content differs between the
    two workspaces become pending.
- Logs go to stderr (in server mode also as `log` notifications). Stdout carries only protocol
  messages or the CLI report.

### 4.2 extension (TypeScript)

- Listens to saves of `.cs`, `.csproj`, `.props`, `.targets` and `.json` files (and `.sln`/`.slnx`,
  which make the analyzer reload) and debounces them (`aftershock.debounceMs`, default 1500 ms).
  Files under `bin/` and `obj/` are ignored.
- Starts, monitors and restarts the analyzer process (`dotnet aftershock-analyzer.dll serve --solution
  X`, `aftershock.dotnetPath`). Restarts with backoff (1, 2, 5, 10, 30 s; a process that lived 60 s
  resets the count; the sixth quick crash in a row ends the retries until `Aftershock: Restart Analyzer`) and
  reports crashes with the last analyzer stderr lines in the output channel. A load failure
  (`initialize` fails) is shown and not retried; saving a project file or `Restart Analyzer` starts
  it again. `log` notifications go to the output channel; stderr only at trace level (it repeats them).
- The analyzer is published framework-dependent and portable into `extension/dist/analyzer`
  (`npm run bundle-analyzer`, also run by `vscode:prepublish`) and ships in the VSIX. In a development
  host the repository's `analyzer/.../bin/{Release,Debug}/net8.0` build is used when there is no
  bundle; `AFTERSHOCK_ANALYZER_DLL` overrides both.
- Solution: `aftershock.solution`, else the first `.sln`/`.slnx` in the workspace root (case-insensitive
  name order, `.sln` before `.slnx`), else the shallowest one up to three folders below it; the output
  channel says which and why. One solution per window (the first workspace folder that has one).
- Every successful `impact` result is merged into the **pending work** (per test project: selected
  tests, or "run everything" with the fallback reasons), also the result of a request that was
  superseded by a newer save: its snapshot advanced, so its tests would otherwise be lost. A
  `-32800` answer is not a failure (the analyzer keeps those files pending). Any other analysis
  failure (crash, `-32603`) runs every test project of the solution, with the reason. Work leaves the
  pending set only after its tests ran; it is kept in `workspaceState` (per solution) together with
  the failed tests, so a reload loses nothing. A report that changed nothing relevant (only ignored
  files, no tests, no fallback) starts no run.
- Runs `dotnet build` / `dotnet test` as child processes. A new save cancels the running job.
  Cancellation kills the whole process tree: `taskkill /T /F /PID <pid>` on Windows; on Unix every
  child is spawned detached (own process group) and the group is killed. MSBuild worker nodes and
  the compiler server are not killed after a **normal** exit (they are shared and harmless; node reuse
  is off anyway).
- If a debug session is active (`vscode.debug.activeDebugSession`), no build or test starts.
  The status bar shows "waiting for debug session" to avoid file-lock conflicts in `bin/`. A debug
  session that starts during a build cancels it; the pending work runs when the last session ends.
  Saves are still analyzed meanwhile (and while paused), so the selection stays complete.
- Architecture: the orchestration core (`extension/src/core`: analyzer host and JSON-RPC client,
  orchestrator, planner, filter builder, restore check, runner-mode detection, TRX parser, process
  runner, test locator) does not import `vscode` (enforced by ESLint) and is unit-tested in plain
  Node; `src/extension.ts` and `src/vscode/*` are a thin layer for the status bar, Problems panel,
  commands and settings. The run pipeline has hooks (`beforeRun`, `testArguments` for the coverage
  arguments, `afterProject` with the results folders, `afterRun`); M4's `CoverageManager` implements
  them, and the orchestrator asks it for the extra `impactSinceBase` selection of saved files and for
  follow-up runs (7.4). Coverage colors, gutter icons and decorations live in `src/vscode`.
- All UI strings are English, with a Turkish localization: `package.nls.json` /
  `package.nls.tr.json` for contributions and `vscode.l10n` bundles (`l10n/bundle.l10n.tr.json`)
  for runtime strings. The output channel is a technical log and stays English.
- `engines.vscode` is `^1.85.0` (corporate machines lag behind); the integration test runs on 1.85.2.
  The Marketplace publisher ID is a placeholder (`aftershock-dev`) until publishing (M6).

## 5. Impact analysis

### 5.1 Changed members

- Compare the old snapshot of each changed document with the new one (line diff; line
  terminators are not compared, so CRLF/LF differences are invisible).
- Map each changed line to the **innermost member** in the Roslyn syntax tree: method,
  constructor, destructor, property or indexer accessor (an expression-bodied property is its
  getter), event, operator, conversion operator. Local functions and lambdas map to their
  containing member. A property header (attributes, modifiers, type, name), its accessors and
  its initializer are compared separately, so `{ get; set; }` -> `{ get; private set; }` is a
  setter change only.
- Every candidate is **confirmed** by comparing the old and new declaration with trivia
  ignored (`SyntaxFactory.AreEquivalent`). Comment-only and whitespace-only edits, and
  alignment artifacts of the line diff (a closing brace attributed to the neighbouring
  member), select nothing.
- Changes outside any member (attributes or modifiers of the type, base list, type parameters,
  primary constructor, field declarations) mark **every member of that type** as changed,
  including fields (a changed constant is followed to its readers) and implicit constructors.
  File-level changes (usings, namespace, assembly attributes) do this for every type of the
  file. A changed instance property initializer also marks the instance constructors.
- **Added members.** In production code, adding a member marks every member of its type as
  changed (a new overload or a hiding member can change which method existing calls bind
  to). In types of **test projects** (test classes, base test classes, fixtures, helpers) and
  in any type that declares or inherits test methods, this rule is not applied: a new test
  method selects only itself, and a new helper is followed through its own references (the
  tests that call it changed as well). If the same edit also changes something outside the
  members (for example a field), the type-level rule applies as usual.
- **Deleted members** are resolved in a fork of the solution in which the changed documents
  carry their old text and deleted documents are re-added (`WithDocumentText`,
  `AddDocument`). Their references are searched there; each caller found is mapped back to
  the current solution by documentation comment id, and the search continues in the current
  solution as soon as the caller still exists. A removed member does not change its type.
- New files: every member of every declared type. Deleted files: every member, resolved in
  the old fork.

### 5.2 Caller search (backwards BFS)

- For each changed symbol, find references with `SymbolFinder.FindReferencesAsync` and walk
  **up** breadth-first: the enclosing member of each reference becomes the next symbol.
  Instance field and property initializers map to the instance constructors; references in a
  type header (attributes, base list) map to the constructors; static initializers map to the
  static field or property itself (the tests that read it), not to the whole class.
- `FindReferencesAsync` cascades in both directions of the inheritance hierarchy. Only
  references bound to the searched symbol itself are kept; the direction is controlled
  explicitly instead:
  - **Upwards (always):** the overridden base member and the implemented interface members
    (`FindImplementedInterfaceMembersAsync`) are queued, so a call through
    `IOrderService.Create` or through an abstract base reaches the tests.
  - **Downwards (never):** when a base, virtual or interface member changes, overrides and
    implementations are not added. Calls through derived types are bound to the base symbol
    unless the derived type overrides it; an override that calls `base.M()` is found as a
    reference; an override that does not call it does not run the changed code; and a changed
    interface signature changes the implementations in the same edit. Adding the downward
    edges would only add false positives.
  - Members declared **outside the solution** (`object.ToString`, `IDisposable.Dispose`,
    `IEquatable<T>.Equals`, ...) are not followed: their callers are framework code and their
    fan-out would hit the BFS limit on every `ToString` override.
- **Properties**: an accessor searches the property and keeps only reads (getter) or writes
  (setter, `init`, object and `with` initializers, deconstruction targets, `out`); `+=`, `++`,
  `??=` and `ref` count as both.
- **Constructors**: object creations (also target-typed `new()`), `base(...)`/`this(...)`
  calls, and derived constructors that call a parameterless base constructor implicitly
  (Roslyn does not report those as references, so they are added explicitly). Reaching a
  static constructor marks the static members and constructors of its type.
- Implicit references Roslyn reports (operators, conversions, `foreach` `GetEnumerator`,
  `Deconstruct`, extension methods, method groups, `nameof`) are followed. Calls that only
  exist at runtime (reflection, DI-only resolution, source-generated registrations that are
  not in the compilation) are not visible; see 5.5 and 5.7.
- Every visited symbol keeps its predecessor, so the first path that reaches a test is its
  **reason chain** (a shortest path), for example:
  `PremiumCalculator.Calculate <- PolicyService.Create <- PolicyServiceTests.Create_ShouldApplyDiscount`.
- Test methods are end points: they are reported and not expanded, and they **do not count**
  toward the symbol limit. A widely used helper therefore selects its many tests instead of
  falling back.
- Limits, per changed file: at most `aftershock.maxImpactedSymbols` non-test symbols
  (default 500). Time: 10 s for the **reference search phase** of a request (all files
  together). Compiling the changed projects and their dependents happens before, outside the
  budget, and is logged as its own phase (it only costs time once in server mode). Hitting a
  limit makes that file (and, for the timeout, every file not searched yet) fall back.

### 5.3 Test detection

A method is a **test method** if it has one of these attributes, or an attribute that
**derives** from one of them (custom `FactAttribute` subclasses are common). An override of a
test method is a test too (the frameworks inherit method attributes).

| Framework | Attributes |
|---|---|
| xUnit v2 / v3 | `[Fact]`, `[Theory]` (data from `[InlineData]`, `[MemberData]`, `[ClassData]`, `[ClassData<T>]`) |
| NUnit | `[Test]`, `[TestCase]`, `[TestCaseSource]`, `[Theory]` |
| MSTest | `[TestMethod]`, `[DataTestMethod]` (with `[DataRow]` / `[DynamicData]`) |

Attributes are matched on the semantic model: the attribute class and its base types are
compared by name (with or without the `Attribute` suffix), and the framework is taken from
the namespace of the matched type (`Xunit*`, `NUnit.Framework`,
`Microsoft.VisualStudio.TestTools.UnitTesting`). When the attribute type cannot be resolved
(for example the project was not restored), the written name is used and the framework comes
from the project's test framework reference.

**Inherited tests.** A test method declared in a base class (abstract or not) runs under every
concrete derived class; it is reported once per concrete class (`Ns.Derived.Method`, the name
the adapters use), with `declaredIn` pointing at the base.

**Whole-class triggers.** If the search reaches one of these members of a test class or of a
**base class** of test classes, all tests of the class and of every concrete derived test
class are impacted:

- constructors (also implicit ones reached through instance field/property initializers),
- `Dispose` / `DisposeAsync`, `IAsyncLifetime.InitializeAsync` / `DisposeAsync` (Task in v2,
  ValueTask in v3),
- `[SetUp]`, `[TearDown]`, `[OneTimeSetUp]`, `[OneTimeTearDown]` (NUnit),
- `[TestInitialize]`, `[TestCleanup]`, `[ClassInitialize]`, `[ClassCleanup]` (MSTest).

Other members of a base test class (helpers, properties) are **not** whole-class triggers:
they are followed through their references, and the tests that use them are reported for
every concrete derived class.

**Fixtures.** Reaching a lifecycle member (constructor, `Dispose`, `InitializeAsync`, ...) of a
type that test classes receive selects those classes completely: `IClassFixture<T>`,
`ICollectionFixture<T>` through `[CollectionDefinition]` and `[Collection("name")]`,
`[Collection(typeof(T))]` or `[Collection<T>]` (xUnit v3), and any other constructor-injected
type (except `ITestOutputHelper` and other framework-provided parameters). Reaching an xUnit v3
assembly fixture (`[assembly: AssemblyFixture(typeof(T))]`), MSTest `[AssemblyInitialize]` /
`[AssemblyCleanup]` or an NUnit `[SetUpFixture]` runs the whole test project (fallback kind
`assemblySetup`).

**Data sources.** Data members are linked to their tests even when they are named by a
string and no symbol reference exists: xUnit `[MemberData("X")]` (with `MemberType`),
`[ClassData(typeof(T))]` / `[ClassData<T>]` (any member of `T`), NUnit `[TestCaseSource]`,
`[ValueSource]`, `[TestFixtureSource]` (whole class), MSTest `[DynamicData]`.

A changed symbol that is itself a test method (new or edited test) is always selected.

### 5.4 Output

For each impacted test: project, fully qualified class and method name, framework, and the
shortest reason chain. For fallbacks: the reason and the set of test projects to run in full.

### 5.5 Safety net (fallback)

In these cases Aftershock does not trust static analysis and runs **all tests of every test
project that depends on the affected projects**. The project graph comes from
`Solution.GetProjectDependencyGraph()`, so no extra tool is needed.

- A `.csproj`, `Directory.Build.props/targets`, `Directory.Packages.props`, `global.json` or
  `nuget.config` changed.
- `appsettings*.json` or a file matching `aftershock.fallbackGlobs` changed.
- `Program.cs`, `Startup.cs`, or a file containing an `IServiceCollection` extension method
  (DI registration) changed.
- The BFS limit or the time limit was hit.
- The analyzer failed, or the document is not in the workspace (for example a project failed
  to load).
- Non-C# sources that compile into the assembly (`.razor`, `.cshtml`, `.xaml`, `.resx`, `.vb`,
  `.fs`, ...).

Build output and tool folders (`bin/`, `obj/`, `TestResults/`, `.vs/`, `.idea/`) and files that
are neither sources nor build inputs are ignored. The full trigger table, with the scope of
each fallback, is in [analyzer-cli.md](analyzer-cli.md#fallback-kinds).

The reason is always shown in the status bar tooltip and the output channel.

### 5.6 Performance

- Reference searches run on demand and are cached per symbol (`ReferenceCache`). An entry stores
  only the spans of the references, per document; every lookup maps them to their enclosing
  members on the current compilation, so cached results never carry symbols of an older solution
  snapshot (which later lookups would not find, and which would keep old compilations alive).
- Invalidation, before every server analysis (correctness first: a cache must never hide a
  reference):
  - A document whose declarations are unchanged (Roslyn's top-level syntax equivalence: only
    method bodies and non-constant initializers differ) cannot change what other documents bind
    to. Only its own slice of every entry, and the source-generated documents of its project, are
    searched again. This is the typical save.
  - Any other change (member, type, signature, attribute, constant, document added or removed,
    project references or options) invalidates the project and its dependents: entries of symbols
    declared there are dropped, every document there is searched again for the other entries.
  - A reload clears the cache.
  - The tests run every server analysis a second time with an empty cache and require identical
    results.
- In the server, compile errors are checked for the changed documents only; binding whole
  dependent projects on every save would cost more than the analysis.
- Measured in M1 (Linux): the sample solution analyzes in about 0.2 s after a 1.1 s load and
  0.8 s compile; a generated solution with 715 documents and 2,400 xUnit tests needs 0.4-1.2 s
  of reference search for changes reaching 9-728 tests (see analyzer-cli.md).
- Measured in M2 on the same generated solution, server mode: the first save after the warm-up
  takes 0.13-0.9 s depending on the reach (4-728 tests), repeated edits of a method 0.12-0.27 s, a
  declaration change 0.24 s. The analysis time of every request is logged per phase.
- The design called for a reverse call index (callee -> callers, built at startup) if typical
  changes took more than 2 s. They take well under 1 s warm, so there is none; revisit with
  numbers from a real large solution.
- The workspace is loaded once in server mode. A full reload is only needed after project
  file changes.

### 5.7 Known limitations

Static analysis cannot see reflection, DI-only paths (a service resolved by interface whose
implementation is never referenced from test code), dynamic, `InternalsVisibleTo` tricks
with reflection, or code generated at runtime. The fallback rules above catch the common DI
case. "Run all tests" (command) and CI remain the safety net.

Deliberate approximations of M1:

- Virtual dispatch is over-approximated: a change in one override selects every test that
  calls the base member, whatever subclass it uses at runtime.
- Calls through members declared outside the solution are not followed (5.2).
- Static initializers map to the static member, not to the whole class (5.2).
- Test projects are recognized by their reference to `xunit.core`, `xunit.v3.core`,
  `nunit.framework` or the MSTest framework assembly.

## 6. Build and test execution

### 6.1 Build

- Build only the test projects that contain selected tests, one after the other (they share their
  dependencies; parallel builds would race on the same `obj/` folders):
  `dotnet build <test.csproj> --no-restore -m -nologo -p:RunAnalyzers=false -p:TreatWarningsAsErrors=false`
  (`-p:RunAnalyzers=false` only with `aftershock.disableAnalyzersInBuild`, default on). CI still runs
  analyzers; Aftershock runs the Sonar rules separately (section 8). Compiler errors (de-duplicated)
  go to the output channel; a failed build keeps its selection pending, and it runs with the next
  change.
- Restore only when needed: first run, the project's assets file missing (`ProjectAssetsFile`, default
  `obj/project.assets.json`), or a file of the project's `ProjectReference` closure, or a
  `Directory.Build.props/targets`, `Directory.Packages.props`, `global.json` or `nuget.config` in a
  folder above any of them, newer than the last successful restore (its start time, kept per project
  in `workspaceState`). A build that fails with `NETSDK1004` (assets file not found) restores and
  builds once more.
- M0 measures how much a single-project incremental build costs on real solutions, with and
  without analyzers ([M0-measurement.md](M0-measurement.md)).
- Measured in M3 (Linux, .NET SDK 10.0.108, `samples/ImpactSample`, TaxRates change reaching 5 xUnit
  tests): save to result 3.3 s with the default 1.5 s debounce on a warm session (analysis 0.02-0.05 s,
  build 0.9 s, `dotnet test` 0.8 s); the first save of a session adds the restore check's first
  restore (0.7 s) and the runner-mode query.

### 6.1.1 Running `dotnet` child processes

- When `dotnet build` / `dotnet test` / `dotnet restore` run with redirected output, MSBuild
  worker nodes reused across builds (node reuse) and the MSBuild server inherit the pipes and
  keep them open after the command itself has exited. Waiting for end-of-stream then hangs
  forever (this hung the M1 analyzer test suite until fixed).
- Always set `MSBUILDDISABLENODEREUSE=1` and `DOTNET_CLI_USE_MSBUILD_SERVER=0` in the child's
  environment (or pass `-nodeReuse:false` and `--disable-build-servers`), wait for the **process
  exit**, and then read the remaining output with a bounded wait instead of waiting for EOF.
  The extension waits at most 2 s for the streams after the exit (the compiler server, started by a
  build, can hold them for minutes).
- Cancellation kills the whole process tree (`Process.Kill(entireProcessTree: true)` on .NET;
  `taskkill /T /F` on Windows from Node; the detached child's process group on Unix). Processes are
  started without a shell; arguments are passed as an array.

### 6.2 Test runner modes

`dotnet test` behaves differently depending on the runner. The extension detects the mode **per
test project** (cached until the project's restore inputs change) and builds the arguments
accordingly:

1. `global.json` (the nearest one above the solution folder, comments allowed) has
   `"test": { "runner": "Microsoft.Testing.Platform" }` -> **MTP** for every project.
2. Otherwise `dotnet msbuild <proj> -getProperty:...` (after restore, so package props count) reads
   `IsTestingPlatformApplication`, `TestingPlatformDotnetTestSupport`, `UseMicrosoftTestingPlatformRunner`,
   `EnableMSTestRunner`, `EnableNUnitRunner`, `OutputType`, `ProjectAssetsFile`.
   `IsTestingPlatformApplication` and `TestingPlatformDotnetTestSupport` both true -> **bridge**;
   anything else -> **VSTest** (an MTP-capable app without `TestingPlatformDotnetTestSupport` runs
   through its VSTest adapter). `OutputType` alone says nothing: `Microsoft.NET.Test.Sdk` makes every
   .NET test project an `Exe`. If the query fails, VSTest is assumed and the output channel says so.

| Mode | How it is selected | Command |
|---|---|---|
| **VSTest** (default) | No `global.json` test runner, no bridge | `dotnet test <proj> --no-build --nologo --logger "trx;LogFileName=<name>.trx" --results-directory <dir> --filter "<expression>"` |
| **VSTest bridge** | MTP app with `TestingPlatformDotnetTestSupport=true`, VSTest-mode `dotnet test` | `dotnet test <proj> --no-build --nologo -- <app options>` |
| **Microsoft.Testing.Platform** (.NET 10 SDK+) | `global.json` test runner | `dotnet test --project <proj> --no-build <app options>` |

App options (bridge and MTP): the selection (below), the report (`--report-xunit-trx
--report-xunit-trx-filename <name>` for xUnit v3, `--report-trx --report-trx-filename <name>` for
MSTest/NUnit, which needs `Microsoft.Testing.Extensions.TrxReport`), `--results-directory <dir>`.

Verified in M3 with `samples/ImpactSample` switched into each mode in a temporary copy (.NET SDK
10.0.108, Microsoft.Testing.Platform 1.9):

- **VSTest**: all four sample projects (xUnit v2, xUnit v3 through `xunit.runner.visualstudio`,
  NUnit3TestAdapter 5.0, MSTest 3.11), including the e2e test and the TRX fixtures.
- **Bridge**: VSTest options are **ignored for every framework** (`--filter`, `--logger`,
  `--results-directory`; warning MTP0001 "VSTest-specific properties are set but will be ignored"):
  an xUnit v3 and an MSTest project ran all tests despite `--filter`. Options after `--` reach the
  test application, but they are joined into one command line and split again, so a value with
  spaces or `|` must carry its own double quotes (the argument is `"C:\a b\results"` including the quotes): verified
  for xUnit v3 (`--filter-method`, `--report-xunit-trx`), MSTest and NUnit 5.2 (`--filter`,
  `--report-trx`). `-p:TestingPlatformCommandLineArguments=...` works too but needs MSBuild escaping.
- **MTP**: xUnit v3 with `--filter-method`, `--filter-class`, `--filter-not-trait` and
  `--report-xunit-trx`; MSTest (`EnableMSTestRunner`) and NUnit (`EnableNUnitRunner`) with a
  VSTest-style `--filter` and `--report-trx`. Exit codes: 0 passed, 2 tests failed, 8 zero tests
  ran (not an error for Aftershock), 5 unknown option. `dotnet test` refuses the whole run when any
  project of the solution is still a VSTest project ("All projects must use that test runner"), even
  with `--project`.
- NUnit's MTP runner needs NUnit3TestAdapter 5.1+: 5.0.0 (the sample's version) crashes under the
  .NET 10 SDK's MTP mode (`KeyNotFoundException`, or `MissingMethodException` with a newer
  TrxReport package). `EnableNUnitRunner` must be set before the adapter's props are imported (for
  example in `Directory.Build.props`); in the project file it is too late.
- xUnit v2 has no MTP runner; a v2 project in MTP mode fails with the SDK's message.
- Not verified: nested classes in `--filter-method` (xUnit v3 is expected to use `+` like the
  analyzer), the bridge on Windows (quoting goes through `CreateProcess` rules there), and the
  console fallback below against a real project without the TRX extension.

In MTP mode **xUnit v3 rejects `--filter`** (exit code 5, "Unknown option '--filter'"). xUnit v3
offers `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, `--filter-uid`,
the `--filter-not-*` variants and `--filter-query`. Exact selection therefore uses repeated
`--filter-method Ns.Class.Method` options, which have the same length limits as 6.4
(`--filter-class` per class, then batches). `aftershock.testFilter` is translated for xUnit v3 when it
is `Trait=Value` / `Trait!=Value` terms joined with `&` (at most one `=`, because xUnit ORs options of
the same kind) into `--filter-trait` / `--filter-not-trait`; anything else is ignored for that project
with a warning. An xUnit project in bridge or MTP mode is treated as xUnit v3.

When a test application has no TRX extension ("Unknown option '--report-trx'"), the run is repeated
without it and the console output is parsed: `failed <name> (<time>)` blocks give the failures; the
other selected tests count as passed when the exit code is 0 or 2.

### 6.3 Filters (VSTest mode)

- Exact selection: `FullyQualifiedName=Ns.Class.Method` terms joined with `|`.
- Literal `\`, `(`, `)`, `&`, `|`, `=`, `!` and `~` in a name are escaped with `\` (VSTest filter
  syntax).
- **xUnit**: `FullyQualifiedName` is `Ns.Class.Method` for every row of a `[Theory]` (the
  data appears only in the display name), so the exact term selects all rows. Nested classes
  appear as `Outer+Inner`.
- **NUnit**: the NUnit adapter puts the arguments of parameterized tests into the fully
  qualified name, for example `Ns.Class.Method(1,2)` for `[TestCase(1, 2)]`, so with the plain VSTest
  filter engine an exact `FullyQualifiedName=Ns.Class.Method` misses them. The originally planned
  prefix term `FullyQualifiedName~Ns.Class.Method\(` **crashes NUnit3TestAdapter 5.0** (verified in M3:
  its VSTest-to-NUnit filter converter loops on the escaped parenthesis until "Insufficient memory");
  an unescaped `(` is rejected ("Missing ')'"). Aftershock therefore selects parameterized NUnit tests
  with `FullyQualifiedName~Ns.Class.Method` (contains, without the parenthesis): it matches every case
  with adapters 3.x-5.x (verified with 5.0 and, under MTP, 5.2) and over-selects only methods whose
  full name contains this one (`Method` also matches `MethodTwo`). Adapter 4+/5 converts `=` into an
  NUnit filter that matches the parameterized method suite too, but 3.x does not, so `~` is the safe
  choice. Non-parameterized NUnit tests use `=`.
- **MSTest**: data rows share `Ns.Class.Method`, like xUnit.
- Display names are never used for selection.
- Extra user filter (`aftershock.testFilter`, for example `Category!=Integration`) is combined
  as `(<selection>)&(<user filter>)`. A project that runs completely gets the user filter alone.

### 6.4 Command-line length

- If the filter is longer than 8000 characters (a constant in M3; a setting can follow if real
  solutions need it), reduce it to class level (`FullyQualifiedName~Ns.Class.`). If it is still too
  long, split the class terms into batches of at most 8000 characters (user filter included) and run
  `dotnet test` once per batch (sequentially, each with its own TRX). The Windows command-line limit
  is about 32K characters. The same limits apply to the xUnit v3 options (`--filter-method` ->
  `--filter-class` -> batches).
- Not done in M3: passing the filter through a generated `.runsettings` file instead of the command
  line (the batches made it unnecessary so far).

### 6.5 Results

- `dotnet test <test.csproj> --no-build --logger "trx;LogFileName=<name>.trx" --results-directory <dir> --filter "<filter>"`
  in VSTest mode. In MTP mode, TRX comes from `--report-trx` (needs the TRX extension) or
  `--report-xunit-trx` (xUnit v3); console parsing is the fallback (6.2). Each run gets its own folder
  under the extension's workspace storage (`results/run-<time>-...`, one subfolder per project and
  batch; the five newest runs are kept), so batches and multi-targeted projects cannot overwrite each
  other's files. Every `.trx` in the folder is read.
- The TRX parser reads the VSTest logger's, MTP's and xUnit v3's files (fixtures from all four sample
  projects in both runners are in `extension/test/fixtures/trx`). Cases are folded into their method
  (`TestMethod/@className` + `@name` without the argument list: NUnit writes `Method(1,2)`, MTP's
  MSTest report `Method (1,True)`); a method failed if any case failed, and the first failing case's
  message and stack trace are kept. When the name is a custom display name, the first stack frame of
  the class gives the method.
- Pass/fail comes from the TRX, not from the exit code; a run without results and a non-zero exit
  code is reported as "could not run" with the end of its output.
- TRX results feed the Problems panel (section 9).
- Tests that failed in the previous run are added to the next run even if not selected, until they
  pass. A previously failed test that produces no result in a later run (deleted, renamed, or
  excluded by the user filter) is forgotten; so are failed tests of a project that ran completely
  without them.

## 7. New-code coverage

Implemented in M4 (`extension/src/core/newCode.ts`, `cobertura.ts`, `coverageMetrics.ts`,
`coverageStore.ts`, `coverageCollection.ts`, `coverage.ts`). With `aftershock.coverageEnabled` off,
nothing of this section runs: no coverage arguments, no extra analysis, no decorations.

### 7.1 What is "new code"

- Target branch: `aftershock.targetBranch`; if empty, `origin/HEAD`, then `origin/main`,
  `origin/master`, `origin/develop` (the first that resolves to a commit). A configured branch that does
  not resolve is an error (no silent fallback); so is a repository without any of the automatic ones.
- `git merge-base HEAD <target>` gives the base commit. `git diff -U0 --no-color <merge-base> -- '*.cs'`
  gives added and modified lines in the working tree (committed, staged and unstaged). Untracked files
  (`git ls-files --others --exclude-standard`) count as entirely new.
- The diff runs with `--no-ext-diff --no-textconv --find-renames --ignore-submodules
  --src-prefix=a/ --dst-prefix=b/ -c core.quotePath=false` and `GIT_OPTIONAL_LOCKS=0`, so user
  configuration cannot change its shape and it never takes the index lock. Hunks are consumed by their
  line counts (a content line that looks like `+++ b/x` is never a header); pure deletions, deleted and
  binary files, mode changes and pure renames add no lines; a renamed and edited file contributes its
  changed lines under the new name (like Sonar, whose git integration detects renames). Quoted paths and
  the tab git appends to names with spaces are handled; CRLF does not change line numbers.
- The repository root comes from `git rev-parse --show-cdup` (not `--show-toplevel`, which resolves
  symbolic links), so paths match the ones VS Code, MSBuild and the compiler use.
- Excluded: files in test projects (folders of the analyzer's test projects), `bin/` and `obj/`, files
  matching `aftershock.coverageExclusions` (Ant-style globs against the repository- and the
  solution-relative path; a pattern without `/` matches the file name at any depth), and from M5a the
  server's `sonar.coverage.exclusions` / `sonar.exclusions`. The threshold and the exclusions come from
  one provider (`CoveragePolicy`) that reports where each value came from, so the server values can
  take precedence without touching the rest.
- Recomputed (cheap: a handful of git calls, about 15 ms on the sample) on every save, before and after each
  run, when `.git/HEAD` or a ref changes (a file watcher on the git directory, worktrees included),
  when the window regains focus (branch switches in a terminal), and when a coverage setting changes.

### 7.2 Collecting coverage

| Tool (`aftershock.coverageTool`) | VSTest | VSTest bridge / Microsoft.Testing.Platform |
|---|---|---|
| `coverlet` (default) | `--collect "XPlat Code Coverage;Format=cobertura"`, needs `coverlet.collector` | `--coverlet --coverlet-output-format cobertura`, needs `coverlet.MTP` |
| `microsoft` | `--collect "Code Coverage;Format=cobertura"`, needs `Microsoft.CodeCoverage` (comes with `Microsoft.NET.Test.Sdk`) | `--coverage --coverage-output-format cobertura`, needs `Microsoft.Testing.Extensions.CodeCoverage` |

- The arguments are added by the executor's `testArguments` hook (after `--` in bridge mode). Before
  adding them, the project's `project.assets.json` (`ProjectAssetsFile` when MSBuild reported one) is
  checked for the package. When it is missing, no arguments are added (an unknown `--coverage` option
  would fail the whole MTP run), the tests run normally, and the output channel and the status bar
  tooltip say which package to add; `coverlet.collector` under Microsoft.Testing.Platform gets its own
  explanation (a VSTest data collector does not run there). A project that ran tests with the
  arguments but wrote no Cobertura file is reported the same way. Its files are never shown as 0%.
- Reports land in the run's results folder (`results/run-<time>-.../<project>-<batch>`, unique per run,
  below the extension's workspace storage). Every `*.xml` with a `<coverage>` root is read; identical
  files (the TRX logger keeps a copy of each attachment) are read once.
- Tools count branches differently (Microsoft Code Coverage counts the compiler's lambda-cache null
  check as two conditions, coverlet does not), so the tool must match the one in the team's Sonar
  pipeline. Note that SonarQube's C# plugin does not import Cobertura: pipelines use coverlet's OpenCover
  format or Microsoft's XML/`.coverage`. Line and condition counts of a tool are the same in all of its
  formats; what Cobertura lacks is *which* conditions were covered (7.4).
- Verified on Linux (.NET SDK 10.0.108) with `samples/ImpactSample`: VSTest + coverlet.collector 6.0.4
  (all four sample projects: xUnit v2, xUnit v3 through its VSTest adapter, NUnit, MSTest), VSTest +
  Microsoft.CodeCoverage 17.14.1 (all four), Microsoft.Testing.Platform + Microsoft.Testing.Extensions.CodeCoverage
  18.0.4 (xUnit v3), the VSTest bridge + the same package (xUnit v3), Microsoft.Testing.Platform +
  coverlet.MTP 8.0.1 (xUnit v3 with `xunit.v3.mtp-v2`). Not working: the bridge with coverlet.MTP,
  because coverlet.MTP needs Microsoft.Testing.Platform 2, which refuses the VSTest bridge under the
  .NET 10 SDK ("Testing with VSTest target is no longer supported"); such projects belong in MTP mode.
- Overhead measured on the sample (Run All, four projects in parallel, warm build): the test phase of
  each project grows from 0.7-1.1 s to 1.2-1.5 s with coverlet and 1.3-1.7 s with Microsoft Code
  Coverage, about 0.4-0.6 s per project; reading the reports takes 5-20 ms.

### 7.3 Formula

Sonar's coverage formula, restricted to new lines:

```
Coverage = (CT + CF + LC) / (2*B + EL)
```

| Symbol | Meaning | From Cobertura |
|---|---|---|
| `EL` | coverable new lines | new lines that appear as `<line>` |
| `LC` | covered new lines | those with `hits > 0` |
| `2*B` | conditions on new lines | denominator of `condition-coverage="50% (1/2)"` |
| `CT + CF` | covered conditions | numerator of `condition-coverage` |

**Distance to the gate** (threshold `t` as a fraction, for example 0.85):

```
needed = ceil(t * (2*B + EL)) - (CT + CF + LC)
```

Computed with exact integer arithmetic (the threshold as a decimal fraction, `BigInt`), never
negative. Example: `EL = 40`, `LC = 30`, `2*B = 10`, `CT + CF = 6`: coverage = 36 / 50 = 72%. For an
85% gate, `ceil(0.85 * 50) - 36 = 43 - 36 = 7` more lines or conditions must be covered. With no
coverable new line the coverage is **n/a** (neither 0% nor 100%) and nothing is needed. The display
has one decimal and is rounded **down** (84.96% shows as 84.9%), so a value below the gate never
shows as the gate.

Parsing: lines are read per `<method>` (class-level `<lines>` repeat them; class-level lines outside
every method are kept). A branch point is identified by its class and method, so the same source line
in several classes or methods (lambdas, local functions, MS's lambda classes) merges as max hits and
the sum of the conditions of *different* methods; the same method listed twice counts once. File
names are resolved against each `<source>` until the file exists (coverlet writes the common folder of
the instrumented files, or `/` with coverlet.MTP), absolute names are kept (Microsoft Code Coverage),
deterministic `/_/` names fall back to the repository and solution folders. Windows paths (drive
letters, UNC, backslashes) are joined with Windows rules regardless of the host, and paths are compared
case-insensitively on Windows and macOS.

Unit tests (`extension/test/unit/coverageMetrics.test.ts`, `cobertura.test.ts`, `newCode.test.ts`)
cover worked examples, real `git diff -U0` output and real reports of both tools in both runner modes
(`extension/test/fixtures/cobertura`, paths scrubbed).

### 7.4 Keeping partial runs consistent

Each run executes only the selected tests, so coverage is stored **per file** and merged
(`coverageStore.ts`, a JSON file per solution in the extension's workspace storage, kept across
reloads):

- An entry holds every coverable line of the file (not only new ones, so a different target branch
  needs no new run), the SHA-1 of the content it was measured on, and the tool. It applies only while
  the file on disk has that content and the tool is unchanged; saving a file with a different content
  removes it.
- **Complete** entries come from a run that contained every test reaching the file's new code. With
  coverage enabled, a save of a C# file with new lines (and no complete entry for its current content)
  sends `impactSinceBase` with `base` = the merge base, `mergeBase: false` and `files: [saved files]`
  after the `impact` request, and merges that selection into the pending work: the run includes the
  tests of **all** members of the file that are new relative to the target, not only the latest edit.
  The file waits as "pending" until a run in which all of those test projects ran and wrote a report;
  its entry is then replaced from that run's reports. A run of every test project (Run All) completes
  every file it reports. A save that changes nothing keeps the entry and asks for nothing.
- **Other files** a run touches are merged into their entry: union of hits per line (max), and per
  branch point the larger number of covered conditions. Files measured only by such partial runs count
  as "not measured yet" (the status bar marks the total with `*`), because their numbers depend on
  which tests happened to run.
- Cobertura only says how many of a line's conditions were covered, not which. Two reports that each
  cover one of two conditions are **ambiguous**: the union is 1 or 2. Merges take the larger count (never
  claiming coverage that may not exist). When test code was saved since the last run and such a merge,
  or any change of a file's new-line coverage, happens in a file with a complete entry, the file gets a
  **follow-up**: after the run is applied, `impactSinceBase` for that file, and one more run with all of
  its tests, which gives the exact numbers in a single report. (Within one run, reports of different
  test projects can be ambiguous in the same way; they are counted conservatively.)
- A file whose content changed during the run takes nothing from it (hashes before the build and after
  the run).
- Calculations always use the saved content on disk, never unsaved editor buffers.
- New code that no test reaches is "unreached" until a run instruments its project; then it counts as
  0% with its real coverable lines.
- `Aftershock: Recompute New-Code Coverage` sends `impactSinceBase` for every new-code file and runs
  the result; all files become complete. Before anything is stored the status shows `New code ?` with
  this hint, never 0%.

Known limits: union merges never remove coverage, so a test that was changed to cover less keeps its
old coverage in files it no longer reaches until they are saved or recomputed; a change in one file
that alters the paths another file's tests take shows in that file at its next save or recompute; the
first save of a file whose new code no test reaches cannot show its coverable lines until some run
instruments its project.

## 8. Sonar integration

Aftershock uses Sonar data only descriptively: it reads the team's own SonarQube server
configuration and runs SonarSource's analyzer locally. Aftershock is **not affiliated with
SonarSource**. SonarQube and SonarScanner are trademarks of SonarSource SA.

### 8.1 Server connection

- Server URL: `aftershock.sonar.serverUrl`. Empty means all Sonar features are off.
- Token: stored in VS Code `SecretStorage` via `Aftershock: Set Sonar Token`. Never written to
  settings files or logs. Requests use `Authorization: Bearer <token>`.
- Project key: `aftershock.sonar.projectKey`; otherwise found in `.github/workflows/*.yml`,
  Azure Pipelines YAML (`projectKey` input), then `sonar-project.properties`.
- Web API calls (all verified against a real server at the start of M5a; fields differ
  between server versions):

| Purpose | Endpoint |
|---|---|
| Server version (logged) | `api/server/version` |
| Quality gate of the project | `api/qualitygates/get_by_project?project=KEY` |
| Gate conditions (`new_coverage` threshold, other new-code conditions) | `api/qualitygates/show` |
| Exclusions | `api/settings/values?component=KEY&keys=sonar.coverage.exclusions,sonar.exclusions` |
| C# quality profile | `api/qualityprofiles/search?project=KEY&language=cs` |
| Active rules with parameters and severities (paged) | `api/rules/search?qprofile=...&activation=true&languages=cs&f=params,severity,...` |
| Installed C# plugin version | `api/plugins/installed` |

- The `new_coverage` threshold replaces `aftershock.coverageThreshold`. Other new-code gate
  conditions (issue counts and so on) are shown as targets in the status bar tooltip.
- Server exclusions are merged with `aftershock.coverageExclusions`.
- Everything is cached (`aftershock.sonar.cacheMinutes`, default 60). If the server cannot be
  reached, the last cache is used, then local settings. The output channel says which.

### 8.2 Analyzer acquisition

Preferred: **the same mechanism SonarScanner for .NET uses in its `begin` step**, because that
guarantees the analyzer version matches the server's C# plugin. M5b starts by documenting
exactly how the scanner obtains the analyzer and rule configuration from the server, and
whether a client can reuse it with a user token. The working assumption to verify: the C#
plugin publishes the analyzer as a static resource described by `sonaranalyzer-cs.*` server
properties, and the scanner downloads it from the server.

Fallback: read the C# plugin version from `api/plugins/installed`, download the matching
`SonarAnalyzer.CSharp` package from the configured NuGet sources, and cache it under the user
profile (versioned folder).

Either way:

- Analyzer DLLs load into a separate `AssemblyLoadContext`.
- Before use, check that the `Microsoft.CodeAnalysis` version the analyzer was built against
  is compatible with the analyzer process's Roslyn. If not, show a clear error and disable
  local rules (impact analysis keeps working).
- **Licensing**: recent `SonarAnalyzer.CSharp` versions are licensed under the SONAR
  Source-Available License v1.0; older versions were LGPL-3.0. Aftershock **does not bundle
  or redistribute** the analyzer. It is downloaded at runtime from the user's own server or
  NuGet feed. Users are responsible for using it in line with that license and their
  organization's policies.

### 8.3 Rule configuration

- Rules active in the quality profile are enabled, all others disabled, through the
  diagnostic options passed to `CompilationWithAnalyzers` (or a generated `.globalconfig`).
  `csharpsquid:S1234` maps to diagnostic ID `S1234`.
- Rule parameters (for example S107 `max`) are written in the `SonarLint.xml` format the
  analyzer expects and passed as an `AdditionalText`.
- Generated code is not analyzed (`sonar.cs.analyzeGeneratedCode=false`).
- Test projects are marked as test code, as the scanner does, so test-specific rule behavior
  matches the server.
- The rule set is cached with the gate thresholds and refreshed on the same schedule.

### 8.4 Running rules

- Only the saved document is analyzed: syntax and semantic analyzer diagnostics for that
  document (`CompilationWithAnalyzers.GetAnalyzerSyntaxDiagnosticsAsync(tree, ...)`,
  `GetAnalyzerSemanticDiagnosticsAsync(semanticModel, span, ...)`), on the warm workspace.
- Runs in parallel with build and test and does not wait for them. A new save cancels the
  previous analysis.
- Time per file is logged. Timeout 15 s per file (some rules are expensive).
- Optional (`aftershock.sonar.analyzeOnType`, default off): also analyze while typing, with
  debounce, on the unsaved buffer.

### 8.5 Showing issues

- VS Code diagnostics with source `Aftershock (Sonar rules)`. Severity mapped from the server
  (blocker/critical -> Error, major -> Warning, minor -> Information, info -> Hint; for
  servers using the software-quality impact model, high/medium/low map to
  Error/Warning/Information).
- Each diagnostic carries the rule ID and a link to the rule page:
  `<serverUrl>/coding_rules?open=csharpsquid:S1234`.
- By default only issues on **new lines** are shown (`aftershock.sonar.showAllIssues` shows
  all).
- The status bar summary includes the issue count, for example `New code: 87% cov · 3 issues`.
  Clicking lists the issues in a Quick Pick and jumps to the selected one.
- The count covers files analyzed in this session. `Aftershock: Analyze All Files in New Code`
  analyzes every file in the diff once, in the background.

### 8.6 Limits (also in the README)

- Edition-specific rules and taint (security data-flow) analysis do not run locally. Results
  are very close to the server's but may not be identical; the pull request analysis is
  definitive.
- Issues marked "won't fix" or "false positive" on the server still show locally. Low-priority
  improvement: fetch them with `api/issues/search` and hide matches by rule, file and line
  content.
- Optional, low priority: list open issues from the branch's or pull request's last server
  analysis (`api/issues/search` with the new-code filter) in a separate view. That reflects the
  last push, not the current state.

## 9. User interface

- **Status bar**: `Analyzing…`, `Building…`, `Testing (12)…`,
  `✓ 12/12 · New code 87% (gate 85%)`, `✗ 2 failed`. Warning color when coverage is below the
  gate. Click opens the output channel. Tooltip shows fallback reasons and gate targets.
  M3 shows (with codicons): `Loading solution…`, `Analyzing…`, `Restoring…`, `Building…`,
  `Testing (N)…` (`Testing…` when whole projects run), `$(check) 12/12`, `$(error) 2 failed` (error
  background), `Build failed`, `Test run failed`, `No impacted tests`, `Waiting for debug session`,
  `Aftershock paused`, `Analyzer failed`. The tooltip has the last run (counts, save-to-result time),
  the fallback reasons and the solution.
  M4 appends the coverage to the result (and to the idle text): `$(check) 12/12 · New code 87% (target 85%)`
  (warning background when `needed > 0`, unless an error background is already shown),
  `New code n/a` (no coverable new lines, or no C# change outside test projects), `New code ?`
  (nothing measured yet, or no target branch), and a trailing `*` when some new-code files are not
  measured completely. The tooltip adds lines and conditions (`Lines: 5/6 · Conditions: 1/2`), the
  "N more line(s) or condition(s)" number, the target branch, the hint to run Recompute, and
  coverage collection problems. The percentage uses the UI language's number format (Turkish:
  `Yeni kod %87 (hedef %85)`).
- **Output channel** ("Aftershock", a log channel whose level the user can change): duration of each
  step, selected tests with reason chains, fallback reasons, the exact `dotnet` commands, analyzer
  and server messages; build output at debug level, analyzer stderr at trace level. After each run the
  new-code coverage: the total with lines, conditions and "N more line(s) or condition(s) to cover to
  reach the target", then one line per file (`src/X.cs: 75% (lines 5/6; conditions 1/2; uncovered: 32;
  partly covered: 27 (1/2))`, or why it is not measured), plus missing coverage packages.
- **Problems panel**: failed tests as diagnostics (source `Aftershock`, code = the test's full name) on
  the test method's declaration line: the analyzer's `file`/`line`; else the declaration found in the
  file of the first stack frame; else a search of the test project's `.cs` files for the class and
  method. Message: the test, the failing case for data-driven tests, the failure message and the first
  five stack lines. The diagnostics are rebuilt from the failed-test store after every run (so they
  clear when tests pass) and restored on startup.
- **Editor decorations**: uncovered new lines red, partially covered new lines (some conditions
  missed) yellow, as gutter marks (SVGs for light and dark themes) plus a light whole-line background
  and an overview-ruler mark in theme colors (`aftershock.uncoveredLineBackground`,
  `aftershock.partialLineBackground`, `aftershock.uncoveredLineRuler`, `aftershock.partialLineRuler`,
  with defaults for light, dark and both high-contrast themes). Only new lines of files whose current
  content was measured are marked; the hover says "New line not covered by any test." or "New line: 1
  of 2 conditions covered (3 hits)." (and that the numbers come from partial runs, when they do). A
  document with unsaved changes keeps its marks (VS Code moves them with the edits) until it is saved
  and measured again. `aftershock.coverageDecorations` turns them off.
- **Commands**:
  - `Aftershock: Run All Tests`
  - `Aftershock: Show Impacted Tests (Why?)`: selected tests with reason chains (M3: a Quick Pick of
    the last run with each test's result and chain; picking one opens it)
  - `Aftershock: Recompute New-Code Coverage`
  - `Aftershock: Pause / Resume`
  - `Aftershock: Restart Analyzer` (M3)
  - `Aftershock: Show Output` (M3)
  - `Aftershock: Set Sonar Token`
  - `Aftershock: Analyze All Files in New Code`
- Later: Test Explorer integration through the VS Code Testing API (`TestController`).
- Localization: English UI strings with a Turkish translation (`vscode.l10n`,
  `package.nls.tr.json`).

## 10. Settings

| Setting | Default | Description |
|---|---|---|
| `aftershock.solution` | auto (first `.sln`/`.slnx` in the workspace root) | Solution to analyze |
| `aftershock.targetBranch` | auto | Comparison branch for new code |
| `aftershock.coverageThreshold` | 85 | New-code coverage target (%) when the server value is not available |
| `aftershock.coverageEnabled` | true | Collect coverage (off: no coverage arguments, analysis, numbers or decorations) |
| `aftershock.coverageTool` | `coverlet` | `coverlet` or `microsoft` (7.2) |
| `aftershock.coverageExclusions` | `[]` | Glob list; keep in sync with the project's `sonar.coverage.exclusions` |
| `aftershock.coverageDecorations` | true | Coverage decorations in the editor (M4; planned as `aftershock.decorations`) |
| `aftershock.fallbackGlobs` | `["**/appsettings*.json"]` | Files that trigger a full test-project run when changed |
| `aftershock.testFilter` | `""` | Extra filter added to every run (for example `Category!=Integration`) |
| `aftershock.debounceMs` | 1500 | Wait after a save |
| `aftershock.maxImpactedSymbols` | 500 | BFS limit |
| `aftershock.disableAnalyzersInBuild` | true | Turn off Roslyn analyzers in Aftershock's builds |
| `aftershock.dotnetPath` | `dotnet` | The `dotnet` executable for the analyzer, builds and tests (M3) |
| `aftershock.sonar.serverUrl` | `""` | SonarQube server; empty disables Sonar features |
| `aftershock.sonar.projectKey` | auto | Found as described in 8.1 when empty |
| `aftershock.sonar.showAllIssues` | false | false: only issues on new code; true: all issues in the file |
| `aftershock.sonar.analyzeOnType` | false | Also analyze while typing |
| `aftershock.sonar.cacheMinutes` | 60 | Cache time for rules and gate thresholds |

## 11. Security and privacy

- No telemetry.
- Network traffic goes only to the SonarQube server the user configures and to NuGet feeds
  (analyzer download). Nothing else.
- Tokens stay in SecretStorage and are never logged.
- Logs and the output channel avoid printing tokens and full request headers.

## 12. Milestones

Each milestone ends in a working state and is verified before the next one starts.

| | Milestone | Done when |
|---|---|---|
| **M0** | Measurement | `scripts/measure-build.ps1` run on a real large solution: restore, full build, `dotnet test --no-build`, and the largest test project's incremental build measured separately. We know how much of the loop is build vs tests. If build dominates, M3 focuses on build optimization. |
| **M1** | Analyzer CLI | `impact` command: changed members relative to a git ref, impacted tests with reason chains as JSON. Fixture solution under `/samples` plus analyzer tests for: direct call and multi-level chains; calls through interfaces; abstract/virtual overrides; property getter/setter; test class constructor and setup methods (whole class selected); xUnit `[Theory]`, NUnit `[TestCase]`, MSTest `[DataTestMethod]`; a change that reaches no test; fallback triggers (csproj, appsettings, DI registration). Accepted when, for several changes in a real repository, results match tests found by hand with "Find All References". |
| **M2** | Server mode | Warm workspace, document updates, caching. Analysis time per typical change logged. |
| **M3** | Extension core loop | Save -> analyze -> build -> filtered test run -> status bar, output channel, Problems panel. Includes cancellation, debug-session check and test runner mode detection (6.2). |
| **M4** | New-code coverage | Git diff, Cobertura parsing, Sonar formula, per-file merge, decorations, "how many more to the gate". Unit tests for the formula. |
| **M5a** | Sonar connection | APIs verified on a real server first (version, gate conditions, exclusions, quality profile, active rules). Then token handling, project key discovery, cached thresholds and exclusions. |
| **M5b** | Local rules | Document how SonarScanner for .NET acquires the analyzer; acquire it, configure it from the quality profile, analyze the saved file, show diagnostics and the status bar summary. Accepted when the code smells reported by the server's last pull request analysis also appear locally in the same files (except edition-specific rules). |
| **M6** | Polish | "Why?" command, Test Explorer integration, settings review, README, Marketplace packaging. |

## 13. Open questions

These are answered by the M0 report and by the first M5a session against a real server:

- Which xUnit flavor and runner mode do the target solutions use (xUnit v2 with VSTest, or
  xUnit v3, possibly on Microsoft.Testing.Platform)? NUnit or MSTest anywhere?
- Which tool collects coverage in the Sonar pipeline (coverlet, Microsoft Code Coverage,
  other), and in which format?
- Server version and edition (Community, Developer, Enterprise). Can users create their own
  tokens?
- Is using `SonarAnalyzer.CSharp` (source-available license) in a local developer tool in line
  with the organization's policy?
