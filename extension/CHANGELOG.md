# Changelog

## 0.1.0 (unreleased)

- Save -> analyze -> build -> filtered test run, with the analyzer bundled in server mode.
- Status bar, output channel with reason chains and commands, failed tests in the Problems panel.
- Cancellation of running builds/tests on a new save (whole process tree), debug-session gate,
  pause/resume, previously failed tests re-run until they pass.
- Runner modes: VSTest, VSTest bridge (Microsoft.Testing.Platform with `TestingPlatformDotnetTestSupport`),
  Microsoft.Testing.Platform (`global.json` test runner).
- New-code coverage: new lines against the target branch (git merge base, working tree, untracked
  files), coverlet or Microsoft Code Coverage in VSTest, bridge and Microsoft.Testing.Platform modes,
  Cobertura parsing, Sonar's formula with "N more to reach the target", per-file store with complete
  recomputation of saved files (`impactSinceBase`) and follow-up runs for ambiguous merges, status bar,
  output and editor decorations, `Aftershock: Recompute New-Code Coverage`, six coverage settings.
- English and Turkish UI.
