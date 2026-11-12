// Test helper: starts a grandchild that sleeps, prints both PIDs, then behaves as asked.
//   node tree.mjs wait      -> keeps running (killed by the test)
//   node tree.mjs exit      -> exits at once; the grandchild keeps the inherited stdout pipe open
import { spawn } from 'child_process';

const mode = process.argv[2] ?? 'wait';
// In exit mode the grandchild is detached: on Windows libuv kills a non-detached child's job object (and its descendants) when the child exits.
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: mode === 'exit' ? 'inherit' : 'ignore', detached: mode === 'exit' });
console.log(`child ${process.pid}`);
console.log(`grandchild ${grandchild.pid}`);
if (mode === 'exit') {
  process.exit(0);
}
setTimeout(() => {}, 120000);
