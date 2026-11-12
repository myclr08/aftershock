# Analyzer CLI (`aftershock-analyzer`)

The analyzer is the C# half of Aftershock. Milestone M1 ships it as a one-shot command line tool:
given a solution and a git base, it lists the **test methods** affected by the changes in the
working tree, with a reason chain for each, or says which test projects must run completely
(fallback). Later milestones reuse the same engine in a long-running server (M2) and call it
from the VS Code extension (M3).

## Requirements

- .NET SDK 8 or newer (the analyzer targets `net8.0` and rolls forward to the newest installed
  runtime, so it can load MSBuild from the newest SDK).
- `git` on `PATH`.
- The solution must be **restored** (`dotnet restore`) before the analyzer runs. Without
  `obj/project.assets.json` the workspace has no package references and the result is
  incomplete; compile errors are reported in `diagnostics`.

## Build and run

```bash
dotnet build analyzer/Aftershock.Analyzer.sln -c Release
dotnet analyzer/src/Aftershock.Analyzer/bin/Release/net8.0/aftershock-analyzer.dll \
  impact --solution path/to/App.sln --base origin/main --json
```

Run the analyzer tests (they copy `samples/ImpactSample` to a temp folder, `git init` it and
restore it; NuGet access is needed once):

```bash
dotnet test analyzer/Aftershock.Analyzer.sln
```

## Trying the analyzer on your own solution

Pre-built zips are attached to the GitHub pre-releases tagged `analyzer-v*`
(`aftershock-analyzer-<version>.zip`, built by `.github/workflows/release-analyzer.yml`). The
build is framework-dependent and portable: the same folder runs on Windows, Linux and macOS.

1. Check the prerequisites: `dotnet --list-sdks` shows an 8.0 or newer SDK, `git --version`
   works. Nothing else is installed; no admin rights are needed.
2. Download `aftershock-analyzer-<version>.zip` and unzip it anywhere, for example
   `C:\tools\aftershock-analyzer-<version>`. If Windows marks the files as downloaded and a
   policy blocks them, `Get-ChildItem -Recurse C:\tools\aftershock-analyzer-<version> | Unblock-File`
   clears the mark.
3. In your repository, make sure the solution is restored and the base branch is current:

   ```powershell
   git fetch origin
   dotnet restore .\YourSolution.sln
   ```

4. Make a change (or check out a branch with changes) and run, from any folder:

   ```powershell
   dotnet C:\tools\aftershock-analyzer-<version>\aftershock-analyzer.dll impact `
     --solution C:\src\your-repo\YourSolution.sln --base origin/main
   ```

   Add `--json > impact.json` for the machine-readable report. `--base` can be any revision:
   `HEAD` (only uncommitted changes), `HEAD~1`, a branch, a commit id. The first line on stderr
   shows which MSBuild/SDK was used.
5. Compare the result with Visual Studio / Rider: for a changed method, run "Find All
   References" and follow the callers up to the test methods. Every test found that way
   should be in the list (and the `chain` shows the path the analyzer took). Extra tests are
   expected when a change touches a type as a whole (`typeChanged`), virtual dispatch, or a
   fixture / setup method (whole class). Missing tests are bugs; please note the change and the
   test.
6. Note the durations at the end of the text output (`workspaceLoad`, `compilation`,
   `referenceSearch`) for a typical change.

Projects in the legacy (non-SDK) format are loaded through the `BuildHost-net472` folder and
need the MSBuild of a Visual Studio or Build Tools installation.

## Usage

```
aftershock-analyzer impact --solution <path.sln> --base <git-ref> [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--solution <path>` | required | `.sln` or `.slnx` to load with `MSBuildWorkspace`. Does not have to be at the git root. |
| `--base <git-ref>` | required | Commit, branch, tag or any revision git can resolve (`HEAD`, `origin/main`, `HEAD~3`, a SHA). |
| `--json` | off | Write the JSON report (below) to stdout. Without it, a human-readable summary is printed. |
| `--max-symbols <n>` | `500` | BFS limit per changed file (test methods are not counted). `0` = no limit. |
| `--timeout-seconds <n>` | `10` | Time budget of the reference search phase, for all files together. `0` = no limit. |
| `--fallback-glob <glob>` | `**/appsettings*.json` | Files that trigger a fallback. Repeatable. Giving any value **replaces** the default. Globs match the path relative to the repository root or to the solution folder; a glob without `/` matches the file name at any depth. Supports `**`, `*`, `?`, `{a,b}`, `[...]`. |
| `--verbose` | off | More detail on stderr. |
| `--help`, `--version` | | |

**Exit codes:** `0` success (including results that are fully or partly a fallback), `1` fatal
error (not a git work tree, workspace could not be created, unexpected exception), `2` usage
error (bad arguments, solution file not found, `--base` does not resolve to a commit).

**Streams:** stdout carries only the report (JSON with `--json`). Logs, per-phase durations and
warnings go to stderr, prefixed with `[aftershock]`.

**Text output** lists the changed files that are analyzed or fall back; ignored files
(documentation, build output, anything that is neither a source nor a build input) are
summarized in one line (`+ 25 ignored file(s)`). The JSON report lists every changed file,
ignored ones included, with `"analysis": "ignored"` and a `note`.

### What "changed" means

- **Old content** = the file at `<base>` (`git cat-file` on the resolved commit).
- **New content** = the working tree on disk: staged and unstaged changes, deletions, and
  untracked files that are not ignored (`git ls-files --others --exclude-standard`).
- Renames are detected (`git diff --find-renames`); a renamed file is compared with its old path.
- Line endings are not compared, so CRLF/LF differences (`core.autocrlf`) are not changes.
- Files in `bin/`, `obj/`, `TestResults/`, `.vs/`, `.idea/` and `.git/` are ignored even when
  git does not ignore them.

## JSON report (schema version 1)

Paths: `changedFiles[].path`/`oldPath` are repository-relative with forward slashes (as git
prints them). **Every other path is absolute, in the OS format.** Optional fields that do not
apply are omitted; `fallback` is always present and `null` when nothing falls back.

Example (abridged: one of six selected tests and one of two test projects shown):

```json
{
  "schemaVersion": 1,
  "tool": { "name": "aftershock-analyzer", "version": "0.1.0" },
  "solution": "C:\\src\\shop\\samples\\ImpactSample\\ImpactSample.sln",
  "repositoryRoot": "C:\\src\\shop",
  "base": "HEAD",
  "baseCommit": "01071794067ceddf2ed788d0fdd4d26342cf096a",
  "durationsMs": {
    "git": 36, "workspaceLoad": 1137, "compilation": 773, "diff": 4,
    "memberMapping": 25, "referenceSearch": 216, "engineTotal": 1081, "total": 2263
  },
  "changedFiles": [
    {
      "path": "samples/ImpactSample/src/Sample.Core/Shipping/ExpressShipping.cs",
      "fullPath": "C:\\src\\shop\\samples\\ImpactSample\\src\\Sample.Core\\Shipping\\ExpressShipping.cs",
      "status": "modified",
      "analysis": "selective"
    }
  ],
  "changedSymbols": [
    {
      "symbol": "Sample.Core.Shipping.ExpressShipping.Cost(Sample.Core.Orders.Order)",
      "kind": "method",
      "file": "C:\\src\\shop\\samples\\ImpactSample\\src\\Sample.Core\\Shipping\\ExpressShipping.cs",
      "line": 9,
      "reason": "modified"
    }
  ],
  "fallback": null,
  "tests": [
    {
      "fullyQualifiedName": "Sample.Tests.NUnit.ShippingQuoteServiceTests.Quote_Express_ByQuantity",
      "className": "Sample.Tests.NUnit.ShippingQuoteServiceTests",
      "methodName": "Quote_Express_ByQuantity",
      "framework": "nunit",
      "parameterized": true,
      "project": "C:\\src\\shop\\samples\\ImpactSample\\tests\\Sample.Tests.NUnit\\Sample.Tests.NUnit.csproj",
      "projectName": "Sample.Tests.NUnit",
      "file": "C:\\src\\shop\\samples\\ImpactSample\\tests\\Sample.Tests.NUnit\\ShippingQuoteServiceTests.cs",
      "line": 33,
      "reason": "referenceChain",
      "chain": [
        "ExpressShipping.Cost",
        "ShippingMethod.Cost",
        "ShippingQuoteService.Quote",
        "ShippingQuoteServiceTests.Quote_Express_ByQuantity"
      ]
    }
  ],
  "testProjects": [
    {
      "name": "Sample.Tests.NUnit",
      "path": "C:\\src\\shop\\samples\\ImpactSample\\tests\\Sample.Tests.NUnit\\Sample.Tests.NUnit.csproj",
      "mode": "filter",
      "tests": 4,
      "frameworks": ["nunit"]
    }
  ],
  "stats": { "visitedSymbols": 8, "referenceSearches": 3, "cacheHits": 0 },
  "diagnostics": []
}
```

### Fields

| Field | Description |
|---|---|
| `schemaVersion` | `1`. Additive changes keep the number; breaking changes increment it. |
| `solution`, `repositoryRoot` | Absolute paths. The solution may sit anywhere below the repository root. |
| `base`, `baseCommit` | The ref as given and the full commit id it resolved to. |
| `durationsMs` | `git` (status + old contents), `workspaceLoad`, `diff` (line diff), `memberMapping` (syntactic mapping + symbol resolution), `compilation` (compiling the changed projects and their dependents; not limited by the timeout), `referenceSearch` (BFS, limited by `--timeout-seconds`), `engineTotal`, `total`. |
| `changedFiles[]` | `path`, `oldPath` (renames), `fullPath`, `status` (`added`, `modified`, `deleted`, `renamed`, `untracked`), `analysis` (`selective`, `fallback`, `ignored`), `note` (why it fell back or was ignored). |
| `changedSymbols[]` | Confirmed changed members. `symbol` (C# signature), `kind` (`method`, `constructor`, `staticConstructor`, `destructor`, `operator`, `conversion`, `property`, `indexer`, `getter`, `setter`, `init`, `event`, `field`, `enumMember`, `type`, `entryPoint`), `file`, `line`, `reason`, `detail`. |
| `changedSymbols[].reason` | `modified`; `added` (new member; in production types the whole type is also reported as `typeChanged`, in test-project types it is not); `deleted` (resolved in the base snapshot); `typeChanged` (change outside members: attributes, modifiers, base types, fields, primary constructor, member list; every member of the type counts as changed); `fileChanged` (usings, namespace, assembly attributes; every type of the file); `newFile`; `deletedFile`. |
| `fallback` | `null`, or `{ reasons[], testProjects[] }` where `testProjects` are absolute project paths that must run **completely**. |
| `fallback.reasons[]` | `kind`, `file` (repository-relative, when caused by a file), `message`, `testProjects` (this reason's share). Kinds below. |
| `tests[]` | Selected test methods, sorted by `fullyQualifiedName`. |
| `tests[].fullyQualifiedName` | `Namespace.Class.Method`, nested classes joined with `+`, **without arguments**. This is what the xUnit (v2 and v3) and MSTest adapters report as `FullyQualifiedName`, also for theories / data rows. |
| `tests[].framework`, `parameterized` | `xunit`, `nunit` or `mstest`; `parameterized` is true for xUnit `[Theory]`, NUnit `[TestCase]`/`[TestCaseSource]`/parameterized tests, MSTest `[DataTestMethod]`/`[DataRow]`/`[DynamicData]`. |
| `tests[].project`, `projectName` | The test project the test **runs** in (for an inherited test: the project of the derived class). |
| `tests[].file`, `line` | Declaration of the test method (1-based line). |
| `tests[].declaredIn` | Present when the method is declared in a base class of `className` (inherited test). |
| `tests[].reason` | `changedTest` (the test itself changed), `referenceChain`, `classLifecycle` (constructor/setup/teardown/Dispose of its class or a base class was reached), `fixture` (a fixture of the class was reached), `dataSource` (a MemberData/ClassData/TestCaseSource/DynamicData source was reached). |
| `tests[].chain` | Ordered from the changed symbol to the test, `Type.Member` labels: constructors are `Type..ctor`, accessors `Type.Property.get` / `.set`, symbols that only exist in the base snapshot end with ` (removed)`. The chain is a shortest path. |
| `testProjects[]` | Every test project to build: `name`, `path`, `mode` (`all` when any fallback covers it, otherwise `filter`), `tests` (selected methods in it), `frameworks`. |
| `stats` | `visitedSymbols`, `referenceSearches`, `cacheHits`. |
| `diagnostics[]` | `severity` (`error`, `warning`), `source` (`workspace`, `compilation`, `analysis`), `message`. Every `MSBuildWorkspace` failure/warning and every compile error summary ends up here (and on stderr). |

### Fallback kinds

| Kind | Trigger | Test projects that run completely |
|---|---|---|
| `buildFile` | `*.csproj` (and other project files) | That project and its dependents |
| `buildFile` | `Directory.Build.props/targets/rsp`, `Directory.Packages.props`, `Directory.Solution.*`, `global.json`, `nuget.config` | Projects in that folder and below, and their dependents |
| `buildFile` | Any other `*.props` / `*.targets` (can be imported from anywhere) | All projects |
| `buildFile` | `packages.lock.json` | Owning project and dependents |
| `fallbackGlob` | Matches `--fallback-glob` (default `**/appsettings*.json`) | Owning project (deepest project folder above the file) and dependents |
| `entryPoint` | `Program.cs`, `Startup.cs` | Owning project and dependents |
| `diRegistration` | A C# file that declares (before or after the change) an extension method on `IServiceCollection` | Owning project and dependents |
| `notInWorkspace` | A C# file below a project folder that is not a document of the workspace (excluded, or the project failed to load) | Owning project and dependents |
| `unsupportedFile` | `.vb`, `.fs`, `.razor`, `.cshtml`, `.xaml`, `.resx`, `.settings`, `.tt` | Owning project and dependents |
| `bfsLimit` | More than `--max-symbols` symbols reachable from one file | Dependents of the file's projects |
| `timeout` | The reference search exceeded `--timeout-seconds` (the file being searched and every file not searched yet) | Dependents of those files' projects |
| `error` | The analysis of a file threw | Dependents of the file's projects |
| `assemblySetup` | The search reached MSTest `[AssemblyInitialize]`/`[AssemblyCleanup]`, an NUnit `[SetUpFixture]`, or an xUnit v3 assembly fixture | That test project |

Fallbacks and selective results coexist: files that fall back contribute whole projects, the
other files contribute individual tests. A project that is both is reported once with
`mode: "all"`.

### Notes for building `dotnet test --filter` (M3)

Checked against the adapters used by `samples/ImpactSample` (xunit.runner.visualstudio 3.1,
NUnit3TestAdapter 5.0, MSTest 3.11):

- xUnit and MSTest: `FullyQualifiedName=<fullyQualifiedName>` matches every data row of a
  theory/data test.
- NUnit with `parameterized: true`: the adapter appends the arguments
  (`Ns.Class.Method(1,14.99d)`), so `FullyQualifiedName=` does not match. Use a prefix match on
  the name plus the opening parenthesis, escaped for the VSTest filter syntax:
  `FullyQualifiedName~Ns.Class.Method\(`. Non-parameterized NUnit tests can use `=`.
- Inherited tests are reported per concrete class (`Ns.Derived.Method`), which is the name all
  three adapters use.

## How tests are selected

1. **Changed members.** Line diff between the old and new text, each changed line mapped to the
   innermost member: method, constructor, destructor, operator, conversion, property/indexer
   accessor (an expression-bodied property is its getter), event. Lambdas and local functions
   belong to their member. Every candidate is confirmed by comparing the old and the new
   declaration with trivia ignored, so comment-only or whitespace-only edits select nothing.
   Changes outside members make every member of the type changed (see `typeChanged`); fields
   count as outside members. Adding a member to a production type does the same (a new
   overload can change existing calls); adding a member to a type of a test project (or any
   type with test methods) does not: a new test method selects only itself, a new helper is
   followed through its references. New files: every member of every type. Deleted members and files are
   resolved in a fork of the solution where the changed documents carry their base text (and
   deleted documents are re-added); their references are searched there and mapped back to the
   current solution when the caller still exists.
2. **Backward search (BFS).** `SymbolFinder.FindReferencesAsync` for each symbol; each reference
   is mapped to its enclosing member, which is queued. Only references bound to the searched
   symbol are used (Roslyn's own cascading is filtered out); the search adds the overridden
   base member and the implemented interface members explicitly, so calls through a base
   class or an interface are found. Property accessors search the property and keep only
   reads (getter) or writes (setter, `init`, object initializers, deconstruction); `+=`, `++`
   and `ref` count as both. Instance field/property initializers map to the constructors.
   References in a type header (attributes, base list) map to the constructors. Derived
   constructors with an implicit `base()` call are followed. Members declared outside the
   solution (for example `object.ToString`, `IDisposable.Dispose`) are not followed.
3. **Tests.** A test method has `[Fact]`, `[Theory]`, `[Test]`, `[TestCase]`, `[TestCaseSource]`,
   `[TestMethod]` or `[DataTestMethod]` (or an attribute deriving from one; matched by name along
   the attribute's base types, with or without the `Attribute` suffix). A test declared in a
   base class is reported for every concrete derived class. Whole classes are selected when the
   search reaches a constructor, an instance initializer, `[SetUp]`/`[TearDown]`/
   `[OneTimeSetUp]`/`[OneTimeTearDown]`, `[TestInitialize]`/`[TestCleanup]`/`[ClassInitialize]`/
   `[ClassCleanup]`, `Dispose`/`DisposeAsync`, `IAsyncLifetime.InitializeAsync`/`DisposeAsync`
   (Task in v2, ValueTask in v3) of the class or of a base class; or a lifecycle member of a type
   the class receives as a fixture: `IClassFixture<T>`, `ICollectionFixture<T>` through
   `[CollectionDefinition]` + `[Collection("name")]`, `[Collection(typeof(T))]` or
   `[Collection<T>]`, and any other constructor-injected type. Data sources are followed even
   when they are named by a string: `[MemberData("X")]` (with `MemberType`), `[ClassData(typeof(T))]`,
   `[ClassData<T>]`, NUnit `[TestCaseSource]`/`[ValueSource]`/`[TestFixtureSource]`, MSTest
   `[DynamicData]`.
4. **Fallback** as in the table above.

## Engine API (for the server mode)

The CLI is a thin front-end over `Aftershock.Analyzer.Engine.ImpactEngine`:

```csharp
var engine = new ImpactEngine(log, cache);           // cache: ReferenceCache, may be kept between calls
ImpactResult result = await engine.AnalyzeAsync(solution, changes, options, cancellationToken);
```

- `solution` is the **current** state (an `MSBuildWorkspace` solution, possibly updated in memory
  with `WithDocumentText`).
- `changes` are `FileChange(Path, Kind, OldPath, OldText, NewText, ...)` records: "old snapshot vs
  new content" per file. The CLI fills them from git; a server fills them from its own
  per-document snapshots. Git is not used by the engine.
- `ReferenceCache` stores reference search results per symbol, sliced per document.
  `InvalidateDocument(documentId)` drops one document's slice from every entry (the next lookup
  re-searches only that document) and drops entries whose symbol is declared in it.
- `MSBuildSetup.Register(workingDirectory)` must run before any workspace type is used.

## Measured performance (Linux, .NET SDK 10.0.108)

| Solution | Change | Load | Compile | Reference search | Total |
|---|---|---|---|---|---|
| `samples/ImpactSample` (6 projects, 70 documents) | one method, 5 tests via a 4-level chain | 1.1 s | 0.8 s | 0.2 s | 2.3 s |
| Generated: 4 projects, 715 documents, 2,400 xUnit tests | one method reaching 241 tests | 1.0 s | 0.9 s | 0.5 s | 2.5 s |
| same | one method reaching 728 tests (123 callers) | 1.0 s | 0.9 s | 1.2 s | 3.2 s |
| same | a hub reaching 300 services | | | 1.6 s | 3.7 s (falls back: `bfsLimit`) |

Load and compile happen once per process; in the server mode (M2) only the reference search is
paid per save.

## Known limitations

- Runtime-only links are invisible: reflection, DI resolution (covered by the DI/entry point
  fallbacks), source-generated registrations that are not part of the compilation.
- Virtual dispatch is over-approximated: a change in one override selects every test that calls
  the base member, whichever subclass it uses.
- Adding a member to a production type makes every member of that type changed (as specified),
  even when the new member cannot affect overload resolution.
- Static field/property initializers map to the field/property (tests that read it), not to the
  whole class.
- Calls through members declared outside the solution (`object.Equals`, `IComparer<T>.Compare`
  implemented by a framework type, ...) are not followed.
- Test projects are recognized by their reference to `xunit.core`, `xunit.v3.core`,
  `nunit.framework` or the MSTest framework assembly.
- The timeout covers only the reference search; compiling a cold solution is measured separately.
