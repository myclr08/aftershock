# Aftershock for VS Code

> **Preview.** Built from the [Aftershock repository](https://github.com/myclr08/aftershock). The
> Marketplace publisher ID (`aftershock-dev` in `package.json`) is a placeholder until the extension
> is published.

**Save a C# file, and only the tests your change can reach are built and run.**

On every save, a Roslyn analyzer that keeps your solution loaded finds the **test methods** your
change can reach (through callers, interfaces, overrides, fixtures and data sources). Aftershock then
builds only the test projects that contain them and runs exactly those tests.

- **Status bar**: `Analyzing…`, `Building…`, `Testing (5)…`, then `✓ 5/5` or `✗ 2 failed`. Click
  it to open the output.
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

Changing `solution`, `dotnetPath`, `maxImpactedSymbols` or `fallbackGlobs` restarts the analyzer.

## Known limitations

- Code reached only through reflection or runtime-only DI paths is invisible to static analysis.
  `Run All Tests` and CI remain the safety net.
- One solution per window (the first workspace folder with a solution).
- New-code coverage and Sonar rules are not part of this version yet.

The UI is in English and Turkish.
