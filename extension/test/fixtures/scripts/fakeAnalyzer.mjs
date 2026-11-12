// A stand-in for `aftershock-analyzer serve` that speaks the same newline-delimited JSON-RPC.
// Behaviour (environment):
//   FAKE_MODE=normal|loadFail|crashOnImpact|crashAtStart|slowImpact
//   FAKE_IMPACT_DELAY_MS  delay of each impact answer (slowImpact)
//   FAKE_STATE_FILE       file counting the starts (crashAtStart crashes until FAKE_CRASHES starts)
import * as fs from 'fs';
import * as readline from 'readline';

const mode = process.env.FAKE_MODE ?? 'normal';
const solutionIndex = process.argv.indexOf('--solution');
const solution = solutionIndex >= 0 ? process.argv[solutionIndex + 1] : 'unknown.sln';
const testProject = { name: 'App.Tests', path: '/repo/tests/App.Tests/App.Tests.csproj', frameworks: ['xunit'] };

if (mode === 'crashAtStart') {
  const file = process.env.FAKE_STATE_FILE;
  const starts = (file && fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
  if (file) fs.writeFileSync(file, String(starts));
  if (starts <= Number(process.env.FAKE_CRASHES ?? '1')) {
    process.stderr.write(`[aftershock] fatal: simulated crash ${starts}\n`);
    process.exit(3);
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const inFlight = new Map();
let initialized = false;

function report(files) {
  return {
    schemaVersion: 1,
    solution,
    repositoryRoot: '/repo',
    durationsMs: { total: 5 },
    changedFiles: files.map((f) => ({ path: f, fullPath: f, status: 'modified', analysis: 'selective' })),
    changedSymbols: [],
    fallback: null,
    tests: files.map((f) => ({
      fullyQualifiedName: `App.Tests.${f.replace(/\W/g, '_')}Tests.Works`,
      className: `App.Tests.${f.replace(/\W/g, '_')}Tests`,
      methodName: 'Works',
      framework: 'xunit',
      parameterized: false,
      project: testProject.path,
      projectName: testProject.name,
      reason: 'referenceChain',
      chain: ['X.Y', 'Tests.Works'],
    })),
    testProjects: files.length ? [{ ...testProject, mode: 'filter', tests: files.length }] : [],
    stats: {},
    diagnostics: [],
  };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      send({ method: 'log', params: { level: 'info', message: 'loading fake solution' } });
      if (mode === 'loadFail') {
        send({ id, error: { code: -32001, message: 'the workspace could not be loaded: simulated' } });
        return;
      }
      initialized = true;
      send({ method: 'progress', params: { phase: 'ready' } });
      send({
        id,
        result: {
          protocolVersion: 1,
          schemaVersion: 1,
          tool: { name: 'aftershock-analyzer', version: '0.0.0-fake' },
          solution,
          repositoryRoot: '/repo',
          msbuild: 'fake',
          workspace: { generation: 1, projects: 2, documents: 3, loadMs: 1, warmUpMs: 0, testProjects: [testProject] },
          options: { maxSymbols: params?.options?.maxSymbols ?? 500, timeoutSeconds: 10, fallbackGlobs: params?.options?.fallbackGlobs ?? [] },
          capabilities: { impactSinceBase: true, cancellation: true, supersede: true },
          diagnostics: [],
        },
      });
      return;
    case 'impact': {
      if (!initialized) {
        send({ id, error: { code: -32002, message: 'not initialized' } });
        return;
      }
      if (mode === 'crashOnImpact') {
        process.stderr.write('[aftershock] fatal: simulated crash on impact\n');
        process.exit(5);
      }
      if (params?.supersede !== false) {
        for (const [otherId, timer] of inFlight) {
          clearTimeout(timer);
          inFlight.delete(otherId);
          send({ id: otherId, error: { code: -32800, message: 'superseded', data: { reason: 'superseded', by: id } } });
        }
      }
      const delay = Number(process.env.FAKE_IMPACT_DELAY_MS ?? (mode === 'slowImpact' ? '500' : '0'));
      const timer = setTimeout(() => {
        inFlight.delete(id);
        send({ id, result: report(params.files) });
      }, delay);
      inFlight.set(id, timer);
      return;
    }
    case '$/cancelRequest': {
      const timer = inFlight.get(params.id);
      if (timer) {
        clearTimeout(timer);
        inFlight.delete(params.id);
        send({ id: params.id, error: { code: -32800, message: 'cancelled', data: { reason: 'cancelled' } } });
      }
      return;
    }
    case 'status':
      send({ id, result: { state: initialized ? 'ready' : 'loading' } });
      return;
    case 'shutdown':
      send({ id, result: null });
      return;
    case 'exit':
      process.exit(0);
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
rl.on('close', () => process.exit(0));
