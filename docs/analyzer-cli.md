# Analyzer CLI (`aftershock-analyzer`)

The analyzer is the C# half of Aftershock. It has two modes over the same engine:

- `impact` (M1): a one-shot command line tool. Given a solution and a git base, it lists the
  **test methods** affected by the changes in the working tree, with a reason chain for each, or
  says which test projects must run completely (fallback).
- `serve` (M2): a long-running process that keeps the solution loaded and answers JSON-RPC
  requests over stdio, so a save is analyzed in a fraction of a second. The VS Code extension (M3)
  talks to it. See [Server mode](#server-mode-serve).

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

The server mode is started the same way and then driven over stdin/stdout (see
[Server mode](#server-mode-serve)):

```bash
dotnet analyzer/src/Aftershock.Analyzer/bin/Release/net8.0/aftershock-analyzer.dll \
  serve --solution path/to/App.sln
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
| `base`, `baseCommit` | The ref as given and the full commit id it resolved to. Not present in the server's snapshot mode (`impact` request). |
| `mergeBaseOf` | Server base mode only: `"HEAD"` when `baseCommit` is the merge base of HEAD and `base`. Not present otherwise. |
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
| `stats` | `visitedSymbols`, `referenceSearches` (full searches), `cacheHits` (answered from the reference cache), `scopedSearches` (server only, omitted when 0: cached lookups that re-searched only the documents edited since). |
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
| `workspaceReloading` | Server only: a build file changed and the workspace reload has not finished (added to requests with a C# change) | Dependents of the projects whose build files changed |

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

## Server mode (`serve`)

```
aftershock-analyzer serve --solution <path.sln> [--max-symbols <n>] [--timeout-seconds <n>]
                          [--fallback-glob <glob>]... [--verbose]
```

The server loads the solution once, keeps the `MSBuildWorkspace` warm and answers requests until
it is told to stop. The options have the same meaning as for `impact` and are the defaults of every
request; `initialize` and each analysis request can override them.

- **Streams:** stdin and stdout carry protocol messages only. Logs go to stderr
  (`[aftershock] level: ...`) and are also sent as `log` notifications.
- **Exit codes:** `0` after `shutdown` + `exit`, or when stdin reaches end of input; `1` when
  `exit` arrives without a prior `shutdown`, or MSBuild / the .NET SDK cannot be located; `2` usage
  error (bad arguments, solution file not found).
- Child processes the analyzer starts (git, the MSBuild build host) get `MSBUILDDISABLENODEREUSE=1`
  and `DOTNET_CLI_USE_MSBUILD_SERVER=0` (see DESIGN.md 6.1.1).

### Framing

- **JSON-RPC 2.0, one JSON object per line** (UTF-8, terminated by `\n`; `\r\n` and a leading BOM
  are accepted on input). There are no `Content-Length` headers. Messages never contain a raw line
  break; line breaks inside strings are escaped.
- A request has an `id` (number or string), a notification has none. `params` is an object (named
  parameters) or omitted. Batches (JSON arrays) are rejected with `-32600`.
- Requests run concurrently and responses can arrive out of order: match them by `id`. Analyses
  themselves are serialized; the time a request waited is reported as `durationsMs.queue`.

### Lifecycle

1. Start the process. Loading the solution starts immediately.
2. Send `initialize`. It is answered once the workspace is loaded. Before it, every request except
   `initialize`, `status` and `shutdown` fails with `-32002`.
3. After the load the server warms up in the background (creates every compilation and runs one
   reference search, so the first save does not pay for it); `progress` notifications report
   `warmUp`, then `ready`. Requests sent meanwhile wait for it.
4. Send `impact` on every save, `impactSinceBase` when coverage needs the full new code of a file,
   `reload` and `status` as needed.
5. Send `shutdown` (cancels in-flight requests, answers `null`; later requests fail with `-32600`),
   then the `exit` notification. Closing stdin also stops the server.

### `initialize`

| Param | Type | Meaning |
|---|---|---|
| `options` | object | Optional new defaults: `maxSymbols`, `timeoutSeconds`, `fallbackGlobs` (as in the CLI options table). |
| `logLevel` | string | Minimum level of `log` notifications: `debug`, `info` (default), `warning`, `error`, `off`. `debug` also writes debug lines to stderr. |
| `solution` | string | Optional; must name the solution the server was started with. |

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"logLevel":"info"}}
```

Result (abridged: one of four test projects shown):

```json
{
  "protocolVersion": 1,
  "schemaVersion": 1,
  "tool": { "name": "aftershock-analyzer", "version": "0.1.0" },
  "solution": "C:\\src\\shop\\samples\\ImpactSample\\ImpactSample.sln",
  "repositoryRoot": "C:\\src\\shop",
  "msbuild": ".NET Core SDK 10.0.108 (C:\\Program Files\\dotnet\\sdk\\10.0.108)",
  "workspace": {
    "generation": 1, "projects": 6, "documents": 68, "loadMs": 1167, "warmUpMs": 0,
    "testProjects": [
      {
        "name": "Sample.Tests.NUnit",
        "path": "C:\\src\\shop\\samples\\ImpactSample\\tests\\Sample.Tests.NUnit\\Sample.Tests.NUnit.csproj",
        "frameworks": ["nunit"]
      }
    ]
  },
  "options": { "maxSymbols": 500, "timeoutSeconds": 10, "fallbackGlobs": ["**/appsettings*.json"] },
  "capabilities": { "impactSinceBase": true, "cancellation": true, "supersede": true },
  "diagnostics": []
}
```

`protocolVersion` covers the methods and notifications on this page, `schemaVersion` the impact
reports; additive changes keep both numbers. `repositoryRoot` is `null` and
`capabilities.impactSinceBase` is `false` when the solution is not inside a git work tree.
`diagnostics` are the workspace load diagnostics. If the load fails, `initialize` fails with
`-32001`; `reload` tries again.

### `impact` (snapshot mode, on save)

| Param | Type | Meaning |
|---|---|---|
| `files` | string[] | Required (may be empty). Saved files: absolute paths, paths relative to the solution folder, or `file:` URIs. |
| `options` | object | Optional per-request `maxSymbols`, `timeoutSeconds`, `fallbackGlobs`. |
| `supersede` | boolean | Default `true`: cancel every earlier `impact` request that is still running or queued. |

```json
{"jsonrpc":"2.0","id":7,"method":"impact","params":{"files":["C:\\src\\shop\\samples\\ImpactSample\\src\\Sample.Core\\Shipping\\ExpressShipping.cs"]}}
```

**Snapshots.** The server keeps the last analyzed content of every C# file (initially the content
at load time). For each file, `impact` reads the **saved content from disk** (never an editor
buffer), compares it with the snapshot, updates the warm workspace in memory
(`Solution.WithDocumentText`, no reload) and runs the same engine as the CLI. Snapshots advance only
when the request returns a result. The report therefore describes the change since the previous
successful `impact` of that file: saving twice reports only the second edit, and a comment-only
edit selects nothing.

Every `impact` also includes the **pending** files: files of earlier `impact` requests that were
cancelled, superseded or failed, and files whose content changed behind the snapshot (seen by
`impactSinceBase` or by a reload). A change is therefore never lost; it shows up in the next
`impact` that returns a result. `status` lists the pending files.

**Files.**

- A changed C# file is updated in place; a deleted one is removed and analyzed in the old
  snapshot, like a deleted file in the CLI.
- A new C# file is added to the C# project(s) whose folder is the deepest one containing it (SDK
  default compile items assumed; `bin/` and `obj/` excluded). A file that already existed below a
  project at load time without being part of it (excluded with `Compile Remove`, for example) stays
  out and falls back with `notInWorkspace`, as in the CLI. `reload` re-reads the exact project
  contents.
- Other files are classified like in the CLI (`buildFile`, `fallbackGlob`, `unsupportedFile`,
  ignored). A **build file** (`*.csproj`, `Directory.Build.*`, `Directory.Packages.props`,
  `global.json`, `nuget.config`, other `*.props`/`*.targets`, `packages.lock.json`) or the
  solution file itself is answered with its fallback **and** starts a background reload (below).

**Result:** the [JSON report](#json-report-schema-version-1) with these differences:

- `base` and `baseCommit` are not present.
- `changedFiles` lists only files whose content differs from their snapshot; `status` is `added`,
  `modified` or `deleted` (a rename arrives as a deleted and an added file).
- `durationsMs`: `queue` (waiting for an earlier request or the warm-up), `workspaceUpdate` (reading
  files, updating the workspace), `cacheSync` (reference cache invalidation), then the engine phases
  as in the CLI (`compilation`, `diff`, `memberMapping`, `referenceSearch`, `engineTotal`), `total`.
  There is no `workspaceLoad`.
- `diagnostics` are this request's. Compile errors are checked in the changed documents only
  (the CLI checks every affected project).
- `stats.scopedSearches` counts reference lookups served from the cache that only re-searched the
  edited documents.

### `impactSinceBase` (base mode)

| Param | Type | Meaning |
|---|---|---|
| `base` | string | Required. Any git revision (`origin/main`, a branch, a SHA). |
| `mergeBase` | boolean | Default `true`: compare with `git merge-base HEAD <base>` (new code of the branch, as the coverage gate sees it). `false`: compare with `<base>` itself, exactly like the CLI's `--base`. |
| `files` | string[] | Optional: analyze only these files of the change set (paths as in `impact`). The workspace is still updated for every changed file. |
| `options`, `supersede` | | As for `impact` (supersede applies to earlier `impactSinceBase` requests). |

The change set is the CLI's (tracked changes of the working tree against the base commit, renames,
deletions, untracked files), analyzed on the warm workspace. The result is the CLI report with
`base` (as given), `baseCommit` (the commit compared with) and, when the merge base was used,
`mergeBaseOf: "HEAD"`. Snapshots of `impact` do not advance; files whose content the server sees
for the first time become pending for the next `impact`.

For M4 coverage (DESIGN.md 7.4), `{"base": "<target branch>", "files": ["<saved file>"]}` returns the
tests of **all** members of the saved file that are new relative to the target branch.

Errors: `-32602` when the revision does not resolve or HEAD and it have no merge base; `-32600`
when the solution is not in a git work tree.

### `reload`

No params. Reloads the solution from disk into a new workspace and swaps it in. The response
arrives when a reload that started after the request has finished:

```json
{
  "success": true,
  "reason": "requested by the client",
  "durationMs": 927,
  "workspace": { "generation": 2, "projects": 6, "documents": 68, "loadMs": 810, "warmUpMs": 112, "testProjects": [] },
  "pendingFiles": [],
  "diagnostics": []
}
```

(`testProjects` abridged.) Cancelling the request does not stop the reload.

### `status`

No params. Answers immediately, also during a load or an analysis:
`state` (`loading`, `ready`, `failed`, `shuttingDown`), `initialized`, `solution`,
`repositoryRoot`, `tool`, `protocolVersion`, `uptimeMs`, `requestsServed`, `inFlight[]`
(`id`, `method`), `options`, `workspace` (as in `initialize`), `reloading`, `allProjectsDirty`,
`dirtyProjects[]` (project files waiting for a reload), `pendingFiles[]`, `cache` (`symbols`,
`searches`, `scopedSearches`, `hits`, cumulative), `loadError`.

### `shutdown` and `exit`

`shutdown` cancels every other request (they fail with `-32800`, reason `shutdown`) and answers
`null`. The `exit` notification then stops the process.

### Notifications (server to client)

| Method | Params |
|---|---|
| `log` | `level` (`debug`, `info`, `warning`, `error`), `message`, `id` (the request that logged it, if any). Filtered by `initialize`'s `logLevel`. |
| `progress` | `phase`, `id` and `method` of the request, `message`. Background phases: `load`, `warmUp`, `ready`, `reload` (message: the reason). Request phases: `queued`, `git` (base mode), `updateWorkspace`, `classify`, `compile`, `resolve`, `search`, `report`. |
| `workspaceReloaded` | The `reload` result shape, after every background or requested reload (`success: false` and `error` when it failed). |

Example:

```json
{"jsonrpc":"2.0","method":"progress","params":{"id":7,"method":"impact","phase":"search"}}
```

### Cancellation and supersede

- `$/cancelRequest` with `{"id": <id>}` cancels a request.
- A new `impact` cancels every earlier `impact` that is still running or waiting (the extension
  sends one per save); the same holds for `impactSinceBase`. Pass `"supersede": false` to keep
  them.
- A cancelled request fails with `-32800` and
  `"data": {"reason": "cancelled" | "superseded" | "shutdown", "by": <id of the superseding request>}`.
  It has not advanced any snapshot: its files are included in the next `impact`.
- A request whose analysis has already finished cannot be cancelled any more and returns its
  result. **Every successful `impact` result counts**, also one for a request the client meant to
  supersede: merge its tests into the next run.

### Background reload

A build-file change, a solution-file change or `reload` loads a new workspace in the background
while requests keep being answered on the current one. Until a reload caused by build files has
finished, every analysis that contains a C# change adds the fallback reason `workspaceReloading`
for the test projects that depend on the projects whose build files changed (every project for
solution-wide files such as the root `Directory.Build.props`). When the new workspace is swapped in:

- the reference cache is cleared and the warm-up runs again;
- files whose content differs between the old and the new workspace (changed on disk without a
  request, added to or removed from a project) become pending, so the next `impact` reports them;
- `workspaceReloaded` is sent.

A failed reload keeps the current workspace and the `workspaceReloading` fallback; `reload` tries
again. MSBuild and the SDK are chosen once per process (`global.json` next to the solution is read
at start): after an SDK change in `global.json`, restart the server.

### Errors

| Code | When |
|---|---|
| `-32700` | The line is not valid JSON (answered with `"id": null`). |
| `-32600` | Not a JSON-RPC 2.0 request (no `jsonrpc: "2.0"`, no `method`, a batch, an id that is not a number or string), a duplicate `initialize`, a request after `shutdown`, base mode without git, an id that is still in progress. |
| `-32601` | Unknown method. Unknown notifications are ignored. |
| `-32602` | Invalid params (missing `files` or `base`, wrong types, a revision that does not resolve). |
| `-32603` | Unexpected failure of one request; the server keeps running. |
| `-32001` | The workspace could not be loaded. |
| `-32002` | Request before `initialize`. |
| `-32800` | Cancelled, superseded or stopped by `shutdown` (see above). |

### Reference cache

Reference searches are cached per symbol and per document across requests. A cache entry stores
only where the references are (document and span); every lookup maps them again to their enclosing
members on the current compilation, so a result never contains symbols of an older snapshot.
Before each analysis the cache is brought in line with the workspace:

- a document whose declarations did not change (only method bodies or non-constant initializers;
  Roslyn's top-level syntax equivalence) has only its own references searched again, together with
  the source-generated documents of its project;
- any other change (a member, type, signature, attribute, constant or document added, removed or
  changed) can change what other documents bind to, so the entries of symbols declared in that
  project and its dependents are dropped and every document of those projects is searched again.

A cache never hides a reference: the test suite runs every server analysis a second time with an
empty cache and requires identical results.

### Performance (Linux, .NET SDK 10.0.108)

Generated solution of the M1 measurements (4 projects, 715 documents, 2,400 xUnit tests). The
load takes 1.0 s, the background warm-up 1.4 s. Then one `impact` per save, each a body edit of one
method (`Service<n>.Run`), times as reported in `durationsMs.total`:

| Change | First save of it | Repeated edits of the same method |
|---|---|---|
| One method reaching 51 tests (71 symbols) | 0.67 s (1.9 s when saved during the warm-up) | 0.15-0.19 s |
| Methods reaching 4-241 tests | 0.13-0.44 s | 0.11-0.18 s |
| A method reaching 728 tests (974 symbols) | 0.65-0.91 s | 0.23-0.27 s |
| A hub over 300 services (falls back: `bfsLimit`) | 1.0 s | 0.26 s |
| A new member (declaration change), then a body edit in another file | 0.23 s, then 0.27-0.31 s | 0.12-0.13 s |

Two runs of 25 requests each; the process used about 350 MB (RSS) afterwards. The one-shot CLI
needs 2.5-3.7 s for the same changes (load and compile included). Every selective result matched
the generator's call graph. Typical changes stay well below the 2 s at which DESIGN.md 5.6 calls
for a reverse call index, so there is none.

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

## Engine API

Both modes are thin front-ends over `Aftershock.Analyzer.Engine.ImpactEngine`:

```csharp
var engine = new ImpactEngine(log, cache);           // cache: ReferenceCache, may be kept between calls
ImpactResult result = await engine.AnalyzeAsync(solution, changes, options, cancellationToken);
```

- `solution` is the **current** state (an `MSBuildWorkspace` solution, possibly updated in memory
  with `WithDocumentText`).
- `changes` are `FileChange(Path, Kind, OldPath, OldText, NewText, ...)` records: "old snapshot vs
  new content" per file. The CLI fills them from git; the server fills them from its per-file
  snapshots (or from git in base mode). Git is not used by the engine.
- `options` (`ImpactOptions`, a record): `MaxSymbols`, `Timeout`, `FallbackGlobs`,
  `RepositoryRoot`, plus for hosts: `CompileErrors` (`AffectedProjects`, the CLI default, or
  `ChangedDocuments`), `HostFallbacks` (fallback reasons decided by the host, such as
  `workspaceReloading`) and `OnPhase` (progress callback).
- `ReferenceCache` stores, per symbol (project id + documentation comment id) and per document,
  the spans of the references bound to that symbol, and maps them to their enclosing members on
  the solution of each lookup. `InvalidateDocumentReferences(documentId)` (text changed,
  declarations unchanged) re-searches one document's slice of every entry;
  `InvalidateDocument(documentId)` also drops the entries declared in it;
  `InvalidateProjects(projectIds)` (declaration change; pass the changed projects with their
  dependents) drops the entries declared in them and re-searches all their documents for the
  others. `Aftershock.Analyzer.Server.WorkspaceSession` shows how a host keeps the cache in line
  with its solution.
- `MSBuildSetup.Register(workingDirectory)` must run before any workspace type is used.

## Measured performance (Linux, .NET SDK 10.0.108)

| Solution | Change | Load | Compile | Reference search | Total |
|---|---|---|---|---|---|
| `samples/ImpactSample` (6 projects, 70 documents) | one method, 5 tests via a 4-level chain | 1.1 s | 0.8 s | 0.2 s | 2.3 s |
| Generated: 4 projects, 715 documents, 2,400 xUnit tests | one method reaching 241 tests | 1.0 s | 0.9 s | 0.5 s | 2.5 s |
| same | one method reaching 728 tests (123 callers) | 1.0 s | 0.9 s | 1.2 s | 3.2 s |
| same | a hub reaching 300 services | | | 1.6 s | 3.7 s (falls back: `bfsLimit`) |

Load and compile happen once per process; in the server mode only the reference search is paid
per save (see [server performance](#performance-linux-net-sdk-100108)).

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

Server mode only:

- The server sees a file change when a request names the file (or after `reload`). Files changed
  on disk without being named, for example by a branch switch, are picked up by `reload` (they
  become pending) or when they are saved.
- A new C# file is assigned to the project that owns its folder; projects that disable default
  compile items or link files from other folders are only exact after `reload`.
- Non-C# files named in an `impact` request always count as changed (they have no snapshot):
  saving a project file without changing it still falls back and reloads.
- An SDK change through `global.json` needs a server restart.
