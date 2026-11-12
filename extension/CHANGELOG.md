# Changelog

## 0.1.0 (unreleased)

- Save -> analyze -> build -> filtered test run, with the analyzer bundled in server mode.
- Status bar, output channel with reason chains and commands, failed tests in the Problems panel.
- Cancellation of running builds/tests on a new save (whole process tree), debug-session gate,
  pause/resume, previously failed tests re-run until they pass.
- Runner modes: VSTest, VSTest bridge (Microsoft.Testing.Platform with `TestingPlatformDotnetTestSupport`),
  Microsoft.Testing.Platform (`global.json` test runner).
- English and Turkish UI.
