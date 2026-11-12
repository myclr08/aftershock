# Aftershock

**Save a C# file, and only the tests your change can reach run, with new-code coverage and
Sonar C# rules shown live in VS Code.**

> **Status: under development.** Nothing is published to the Marketplace yet. The analyzer (CLI and
> server mode) and the extension's core loop (save, analyze, build, run the impacted tests) work; the
> VSIX can be built from source. See [Roadmap](#roadmap).

## Why

In large .NET solutions, building and running every unit test locally can take around ten
minutes. Tests usually sit in a few big test projects, so picking test *projects* by what
changed barely helps. And if your team's quality gate requires, say, 85% coverage on new
code, you only find out after you push.

Aftershock works at the level of **test methods**:

- **Impacted tests on save.** Roslyn finds the members you changed and walks back through
  their callers, including interface and override paths, until it reaches test methods.
  Only those tests are built and run.
- **New-code coverage, live.** Coverage of the lines you changed relative to the target
  branch, computed with the same formula SonarQube uses, plus how many more lines or
  conditions you need to reach the gate.
- **Sonar C# rules on new code.** Aftershock reads your project's quality profile from your
  SonarQube server and runs SonarSource's own C# analyzer locally on the saved file. Only
  issues on new lines are shown by default.
- **Explains itself.** Every selected test comes with a reason chain, for example
  `PremiumCalculator.Calculate <- PolicyService.Create <- PolicyServiceTests.Create_ShouldApplyDiscount`.
  When static analysis can't be trusted (project files, app settings or DI registrations
  changed), it runs the affected test projects in full and tells you why.

**xUnit** (v2 and v3) is the primary test framework. NUnit and MSTest are supported too.

## How it works

1. On save, the extension sends the change to a long-running C# analyzer process that keeps
   your solution loaded in a Roslyn `MSBuildWorkspace`.
2. The analyzer maps changed lines to members, searches callers breadth-first and returns the
   impacted test methods with reason chains.
3. The extension builds only the test projects that contain those tests (analyzers off for
   speed) and runs `dotnet test` with a filter that selects exactly those methods.
4. Coverage from the run is merged per file and combined with `git diff` against the target
   branch to compute new-code coverage.
5. In parallel, the Sonar rules of your quality profile run on the saved file.

The full technical design is in [docs/DESIGN.md](docs/DESIGN.md).

## Requirements

- VS Code
- .NET 8 SDK or later
- git
- Optional: a SonarQube server and a user token, for gate thresholds, exclusions and local
  rules

Windows is the primary platform. Linux and macOS are supported.

## Installing the extension (preview)

There is no Marketplace release yet. Build the VSIX from source (needs Node.js 22, the .NET 8 or newer
SDK and git):

```bash
cd extension
npm ci
npx @vscode/vsce package        # bundles the analyzer into dist/analyzer first
code --install-extension aftershock-0.1.0.vsix
```

CI also attaches a VSIX to every run of the `Extension` job (artifact `vsix-*`). In VS Code with
restricted marketplace access, install it with **Extensions: Install from VSIX...**.

Open a folder that contains your solution and save a C# file. The status bar shows the steps
(`Analyzing…`, `Building…`, `Testing (5)…`, then `✓ 5/5` or `✗ 1 failed`); click it for the output
channel with the selected tests, their reason chains and the exact `dotnet` commands. Failed tests
appear in the Problems panel at their declaration. Commands: `Aftershock: Run All Tests`,
`Aftershock: Show Impacted Tests (Why?)`, `Aftershock: Pause / Resume`,
`Aftershock: Restart Analyzer`, `Aftershock: Show Output`. Details:
[extension/README.md](extension/README.md).

Run the solution's `dotnet restore` once before the first save (the analyzer needs restored
projects); afterwards Aftershock restores test projects itself when their project files change.

### Developing the extension

```bash
cd extension
npm ci
npm run bundle-analyzer   # dotnet publish of the analyzer into dist/analyzer
npm test                  # unit tests (plain Node, no VS Code)
npm run test:e2e          # the core against a temporary git copy of samples/ImpactSample
xvfb-run -a npm run test:integration   # VS Code 1.85 on a virtual display (no xvfb-run on Windows/macOS)
npm run typecheck && npm run lint
```

Open `extension/` in VS Code and press F5 (`Run Aftershock`) to try it in a development host;
without a bundle it uses the analyzer from `analyzer/.../bin/{Release,Debug}`.

## Settings

Available now: `aftershock.solution`, `aftershock.debounceMs`, `aftershock.maxImpactedSymbols`,
`aftershock.fallbackGlobs`, `aftershock.testFilter`, `aftershock.disableAnalyzersInBuild`,
`aftershock.dotnetPath` (see [extension/README.md](extension/README.md#settings)). Planned:

| Setting | Default | |
|---|---|---|
| `aftershock.targetBranch` | auto | Branch that defines "new code" |
| `aftershock.coverageThreshold` | 85 | Coverage target when the server value is not available |
| `aftershock.coverageTool` | `coverlet` | `coverlet` or `microsoft`; use the same tool as your pipeline |
| `aftershock.sonar.serverUrl` | `""` | Your SonarQube server; empty turns Sonar features off |
| `aftershock.sonar.showAllIssues` | false | Show all issues in the file, not only new code |

The complete list is in [docs/DESIGN.md](docs/DESIGN.md#10-settings). The Sonar token is set
with the `Aftershock: Set Sonar Token` command and stored in VS Code's secret storage, never
in settings files.

## Known limitations

- **Static analysis can miss paths.** Code reached only through reflection or DI
  registrations is invisible to a caller search. Aftershock falls back to running whole test
  projects when DI registrations, project files or app settings change, and "Run All Tests"
  is always one command away. CI remains the final safety net.
- **Local Sonar results are close to the server's, but not identical.** Edition-specific
  rules and taint (security data-flow) analysis do not run locally. Issues marked "won't fix"
  or "false positive" on the server still appear locally. The pull request analysis on your
  server is the definitive result.
- **Coverage tools count branches differently.** Pick the same coverage tool your Sonar
  pipeline uses, or numbers will drift.

## Roadmap

- [ ] **M0** Measurement script for real solutions ([scripts/measure-build.ps1](scripts/measure-build.ps1), [guide](docs/M0-measurement.md)): script ready, waiting for real-world numbers
- [x] **M1** Analyzer CLI: impacted tests with reason chains as JSON
- [x] **M2** Analyzer server mode: warm workspace, incremental updates
- [x] **M3** Extension core loop: save, analyze, build, run filtered tests, report
- [ ] **M4** New-code coverage with the Sonar formula and editor decorations
- [ ] **M5** SonarQube connection and local Sonar C# rules on new code
- [ ] **M6** Polish: "Why?" view, Test Explorer integration, Marketplace release

## Licensing

Aftershock is released under the [MIT License](LICENSE).

The Sonar C# analyzer (`SonarAnalyzer.CSharp`) is **not included**. Aftershock downloads it
at runtime from your own SonarQube server or NuGet feed. Recent versions of that analyzer are
licensed by SonarSource under the SONAR Source-Available License v1.0 (older versions under
LGPL-3.0). Make sure your use complies with that license and your organization's policies.

## Trademarks

Aftershock is an independent project and is not affiliated with, endorsed by or sponsored by
SonarSource SA. SonarQube, SonarScanner and SonarLint are trademarks of SonarSource SA. They
are used here only to describe compatibility.
