# M0: measuring where the time goes

Before building Aftershock's build/test pipeline (milestone M3), we need real numbers from a
large solution: how much of a slow local "build + run all tests" loop goes to **building**, and
how much to **running tests**? If the build dominates, Aftershock has to focus on building as
little as possible. If tests dominate, test selection gives the biggest win.

`scripts/measure-build.ps1` measures this and collects the environment facts the design
depends on (test frameworks, test runner mode, coverage tooling, CI pipeline hints). It writes
a Markdown report you can paste back into the issue or conversation.

## Requirements

- Windows PowerShell 5.1 or PowerShell 7+ (Windows, Linux or macOS). No admin rights, no
  extra modules.
- The .NET SDK that the solution normally builds with, on `PATH`.
- A solution that builds and tests locally the way you normally do it.

## Running it

1. Close Visual Studio, Rider and anything else that builds in the background (VS Code with
   C# Dev Kit is fine if it is idle). Avoid other heavy work while it runs.
2. Copy `measure-build.ps1` somewhere, for example next to the solution. If you downloaded it
   with a browser, unblock it once: `Unblock-File .\measure-build.ps1`.
3. Open PowerShell in the folder that contains the `.sln` / `.slnx` and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\measure-build.ps1 -Anonymize
```

or, in PowerShell 7:

```powershell
pwsh -NoProfile -File ./measure-build.ps1 -Anonymize
```

4. When it finishes, the report is printed and saved in the current folder as
   `aftershock-m0-<yyyyMMdd-HHmm>.md`. Read it, then paste it back.

If a group policy blocks `-ExecutionPolicy Bypass`, you can run the script text as a script
block instead:

```powershell
& ([scriptblock]::Create((Get-Content -Raw .\measure-build.ps1))) -Anonymize
```

This does not help if PowerShell runs in *Constrained Language Mode*
(`$ExecutionContext.SessionState.LanguageMode` prints `ConstrainedLanguage`). The script uses
.NET APIs that this mode blocks. In that case, run the commands from the "What it measures"
table by hand and note the times.

### How long it takes

Roughly: one restore, one full rebuild, one full test run and about six builds of the largest
test project. If your usual "build + all tests" takes 10 minutes, expect 15 to 25 minutes.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `-Solution` | first `.sln`/`.slnx` in the current folder | Solution to measure. `.slnf` solution filters work too. |
| `-TestProject` | the test project with the most `.cs` files | Test project for the incremental scenarios (path or project name). |
| `-Configuration` | `Debug` | Build configuration. |
| `-SkipRestore` | off | Skip `dotnet restore`, for example when restore needs a proxy that only Visual Studio knows about. Packages must already be restored. |
| `-Anonymize` | off | Replace solution, project, assembly, file and CI file names with `S1`, `P1`, `P2`, ... in the report. |
| `-TestFilter` | none | `--filter` expression for the whole-solution test run, for example `"Category!=Integration"` when integration tests need a database. Use what your pipeline uses. |
| `-ExtraTestArgs` | none | Extra arguments for the whole-solution test run, as one string split on spaces. Needed for xUnit v3 in Microsoft.Testing.Platform mode, where `--filter` is not available: `-ExtraTestArgs "--filter-not-trait Category=Integration"`. |
| `-Repeat` | 1 | Run each incremental scenario (4a, 4b, 4c) this many times and report the median. Use 3 if the machine is noisy (VDI). |

## What it measures

All times are wall-clock times of the complete `dotnet` command.

| # | Command | What the number means |
|---|---|---|
| 1 | `dotnet restore <sln>` | Package restore. Usually small when packages are already in the local cache. Not counted in the build/test split. |
| 2 | `dotnet build <sln> --no-restore --no-incremental` | **Full rebuild** of every project. `--no-incremental` makes this a true "compile everything" number that does not depend on what was built before. |
| 3 | `dotnet test <sln> --no-build` | **Running all tests**, with no build. Includes test host startup per test project. Per-assembly durations come from TRX files (or the console output in Microsoft.Testing.Platform mode). |
| 4 | `dotnet build <test.csproj> --no-restore` | Largest test project on its own, right after step 2. A warm-up: it shows whether building a project outside the solution context triggers extra work. Not used in the conclusion. |
| 4a | same as 4 | **No-op incremental build**: nothing changed. This is the fixed cost MSBuild pays just to check that everything is up to date. |
| 4b | same as 4, after touching one source file | **Aftershock's real scenario.** The script sets the last-write time of one `.cs` file in a non-test project that the test project references directly (no content change), then builds the test project. The touched project recompiles, and everything downstream is checked. The report says whether the touched project was actually recompiled. |
| 4c0 | 4 plus `-p:RunAnalyzers=false -p:TreatWarningsAsErrors=false` | No-op build with analyzers off. It primes MSBuild caches for the changed global properties so that 4c measures only the change. |
| 4c | same as 4c0, after touching the file again | Like 4b, with Roslyn analyzers off. **The difference between 4b and 4c is the analyzer cost** that Aftershock can skip in its inner loop (analyzers still run in CI). |

The **conclusion** line compares step 2 (full rebuild) with step 3 (all tests):
`Build 70% vs tests 30%`. The second line gives the inner-loop build cost (4b and 4c).

## Environment facts in the report

These answer the open questions in the design (see [DESIGN.md](DESIGN.md)):

- **.NET SDK** resolved in the solution folder (respects `global.json`), installed SDKs, OS,
  PowerShell version, logical CPU count, memory.
- **Proxy**: whether proxy environment variables are set, and on Windows whether a system
  proxy or PAC script is configured. Only presence, never addresses.
- **NuGet sources**: how many are enabled and whether nuget.org is one of them. Aftershock may
  have to download the Sonar analyzer package, so this matters. Source URLs are never reported.
- **Solution shape**: number of projects and test projects, `.cs` file counts, target
  frameworks.
- **Test frameworks**: xUnit flavor (v2 `xunit` or v3 `xunit.v3`) and versions of
  `xunit.runner.visualstudio`, `Microsoft.NET.Test.Sdk`, NUnit, MSTest, including versions from
  central package management (`Directory.Packages.props`).
- **Test runner mode**: VSTest (default) or Microsoft.Testing.Platform. The report lists
  `<UseMicrosoftTestingPlatformRunner>`, `<TestingPlatformDotnetTestSupport>` and a
  `global.json` `"test": { "runner": ... }` entry. This decides how Aftershock must pass test
  filters (see DESIGN.md).
- **Coverage tooling**: `coverlet.collector`, `coverlet.msbuild`, `Microsoft.CodeCoverage`,
  `Microsoft.Testing.Extensions.CodeCoverage` and others, plus data collectors and formats
  configured in `.runsettings` files.
- **Analyzers and build flags**: analyzer packages (for example `SonarAnalyzer.CSharp`,
  `StyleCop.Analyzers`) and properties such as `TreatWarningsAsErrors`,
  `EnforceCodeStyleInBuild`, `AnalysisLevel`. These explain the 4b/4c difference.
- **CI pipeline hints** from `azure-pipelines*.yml`, pipeline templates, `.github/workflows`,
  `Jenkinsfile` and `.gitlab-ci.yml`: which coverage collector is used (for example
  `"XPlat Code Coverage"` or `"Code Coverage"`), which Sonar coverage property is set
  (`sonar.cs.opencover.reportsPaths` and similar), and whether SonarScanner for .NET is used.
  Only tool and property **names** are reported. URLs, tokens, project keys, filter expressions
  and property values are never read into the report.

## What the script changes, and what it doesn't

- It **builds**, so `bin/` and `obj/` folders are rewritten, as with any build. The last
  incremental builds run with analyzers off, so your next normal build may recompile a few
  projects.
- It changes the **last-write time of one source file** (never its content) and restores the
  original time at the end, also after an error or Ctrl+C.
- It writes the **report** to the current folder. Raw logs and TRX files go to a temporary
  folder (`%TEMP%\aftershock-m0-...`), which the script prints at the end. Logs can contain
  paths, so they are not part of the report.
- It **never** edits file contents, never runs `git`, and makes no network calls except what
  `dotnet restore` does. Telemetry and workload update checks are turned off for its child
  `dotnet` processes, and their output language is set to English so it can be parsed. These
  environment variables are restored when the script ends.

## Troubleshooting

- **Restore fails** (proxy, authenticated feed): restore the way you normally do it (for
  example in Visual Studio), then run with `-SkipRestore`.
- **Build fails**: the report lists the first MSBuild/NuGet error codes. Fix the build or pick
  a solution filter (`-Solution .\Dev.slnf`) that builds.
- **Tests hang or need external services**: stop with Ctrl+C (the file time is still
  restored) and run again with `-TestFilter` (VSTest) or `-ExtraTestArgs`
  (Microsoft.Testing.Platform), matching what your pipeline excludes.
- **"Zero tests ran" / exit code 5 in Microsoft.Testing.Platform mode**: an argument was not
  understood by the test application. xUnit v3 does not support `--filter`. Use
  `--filter-not-trait`, `--filter-class` and similar options through `-ExtraTestArgs`.
- **The wrong test project was picked**: pass `-TestProject <name>`.

## Privacy checklist before pasting

Read the report first. With `-Anonymize` it contains no solution, project, file or CI file
names. Without it, it contains project names and repository-relative paths, but never absolute
paths, user names, machine names, server addresses, tokens or project keys. Package names
from nuget.org are always shown. Analyzer packages and local tools that are not on a known
public list are only counted when `-Anonymize` is used.
