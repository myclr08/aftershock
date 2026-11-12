# Aftershock for VS Code

> **Preview.** Built from the [Aftershock repository](https://github.com/myclr08/aftershock). The
> Marketplace publisher ID (`aftershock-dev` in `package.json`) is a placeholder until the extension
> is published.

**Save a C# file, and only the tests your change can reach are built and run, with the coverage of
your new code shown live.**

On every save, a Roslyn analyzer that keeps your solution loaded finds the **test methods** your
change can reach (through callers, interfaces, overrides, fixtures and data sources). Aftershock then
builds only the test projects that contain them and runs exactly those tests.

- **Status bar**: `Analyzing…`, `Building…`, `Testing (5)…`, then `✓ 5/5 · New code 87% (target 85%)`
  or `✗ 2 failed`. Click it to open the output.
- **Problems panel**: failed tests appear at the test method's declaration, with the failure message
  and the first lines of the stack trace. They disappear when the test passes.
- **Output channel "Aftershock"**: every selected test with its reason chain (for example
  `TaxRates.ForCountry <- PriceCalculator.Tax <- PriceCalculatorTests.Total_IncludesTax`), fallback
  reasons, the exact `dotnet` commands and the duration of each step.
- **Tests that failed are run again** on every following run, even when the next change does not
  reach them, until they pass.
- **A new save cancels** the running build or test run (the whole process tree) and starts over with
  the combined selection.
- **Debug sessions are respected**: while you debug, nothing is built (to avoid locked files in
  `bin/`); pending work runs when the session ends.
- **New-code coverage**: the lines you added or changed against the target branch (`origin/main` and
  friends, or `aftershock.targetBranch`), measured with the same formula as SonarQube
  (`(covered conditions + covered lines) / (conditions + coverable lines)`), with "N more lines or
  conditions to reach the target". New lines that no test covers are marked red in the editor, lines
  with uncovered conditions yellow (gutter, line background and hover). The output lists every file.

## New-code coverage

- When you save a file, the run includes the tests of **every** member of that file that is new
  relative to the target branch, so the file's coverage is always complete after a save. Other files a
  run happens to touch are merged in; a file measured only that way counts as "not measured yet" (the
  status shows `*`). `Aftershock: Recompute New-Code Coverage` measures all new code at once; until
  something is measured the status shows `New code ?`, never 0%.
- When you save test code and a changed test reaches another file's new code, that file is measured
  again in a short second run (Cobertura reports cannot say *which* conditions two runs covered).
- Coverage needs a package in each test project:

  | | VSTest | Microsoft.Testing.Platform (and the VSTest bridge) |
  |---|---|---|
  | `coverlet` (default) | `coverlet.collector` | `coverlet.MTP` (needs Microsoft.Testing.Platform 2, not the bridge) |
  | `microsoft` | `Microsoft.CodeCoverage` (part of `Microsoft.NET.Test.Sdk`) | `Microsoft.Testing.Extensions.CodeCoverage` |

  A missing package is reported in the output and the status tooltip; tests still run.
- Collecting coverage adds roughly half a second per test project run on a small solution.

When static analysis cannot be trusted (a project file, `Directory.Build.props`, `appsettings*.json`,
`Program.cs` or a DI registration changed), the affected test projects run completely and the output
says why.

## Requirements

- .NET SDK 8 or newer on `PATH` (or set `aftershock.dotnetPath`), and `git`.
- A solution file (`.sln` or `.slnx`). The first one in the workspace root is used; set
  `aftershock.solution` to pick another.
- xUnit (v2, v3), NUnit or MSTest test projects. VSTest, the VSTest bridge
  (`TestingPlatformDotnetTestSupport`) and the .NET 10 SDK's Microsoft.Testing.Platform mode
  (`global.json` `test.runner`) are detected per project.

## Commands

| Command | |
|---|---|
| `Aftershock: Run All Tests` | Builds and runs every test project of the solution. |
| `Aftershock: Show Impacted Tests (Why?)` | The tests of the last run with their reason chains; pick one to open it. |
| `Aftershock: Recompute New-Code Coverage` | Runs the tests of all new code and measures its coverage completely. |
| `Aftershock: Pause / Resume` | Stop building and running until resumed (saves are still analyzed; the work runs on resume). |
| `Aftershock: Restart Analyzer` | Restart the analyzer process (for example after an SDK change in `global.json`). |
| `Aftershock: Show Output` | Open the output channel. |

## Settings

| Setting | Default | |
|---|---|---|
| `aftershock.solution` | auto | Solution to analyze (absolute or relative to the workspace folder). |
| `aftershock.debounceMs` | `1500` | Wait after a save before analyzing; saves in this window are analyzed together. |
| `aftershock.maxImpactedSymbols` | `500` | Caller search limit per changed file; above it, the dependent test projects run completely. |
| `aftershock.fallbackGlobs` | `["**/appsettings*.json"]` | Files whose change runs the dependent test projects completely. |
| `aftershock.testFilter` | `""` | Extra VSTest filter for every run, for example `Category!=Integration`. |
| `aftershock.disableAnalyzersInBuild` | `true` | Build with `-p:RunAnalyzers=false` for faster feedback. |
| `aftershock.dotnetPath` | `dotnet` | The `dotnet` executable. |
| `aftershock.coverageEnabled` | `true` | Collect coverage and show new-code coverage. |
| `aftershock.targetBranch` | auto | Branch that defines new code; empty: `origin/HEAD`, `origin/main`, `origin/master`, `origin/develop`. |
| `aftershock.coverageThreshold` | `85` | Target in percent (warning color, "N more"); a SonarQube gate will take precedence later. |
| `aftershock.coverageTool` | `coverlet` | `coverlet` or `microsoft`: the tool your Sonar pipeline uses. |
| `aftershock.coverageExclusions` | `[]` | Globs of files that do not count, for example `**/Migrations/**` (keep in sync with `sonar.coverage.exclusions`). |
| `aftershock.coverageDecorations` | `true` | Mark uncovered (red) and partly covered (yellow) new lines in the editor. |

Changing `solution`, `dotnetPath`, `maxImpactedSymbols` or `fallbackGlobs` restarts the analyzer.
The decoration colors can be changed with `workbench.colorCustomizations`
(`aftershock.uncoveredLineBackground`, `aftershock.partialLineBackground`,
`aftershock.uncoveredLineRuler`, `aftershock.partialLineRuler`).

## Known limitations

- Code reached only through reflection or runtime-only DI paths is invisible to static analysis.
  `Run All Tests` and CI remain the safety net.
- One solution per window (the first workspace folder with a solution).
- Coverage merged from partial runs never shrinks: a test changed to cover less keeps its old coverage
  in files it no longer reaches until they are saved or recomputed.
- SonarQube rules and the server's gate threshold and exclusions are not part of this version yet.

The UI is in English and Turkish.
