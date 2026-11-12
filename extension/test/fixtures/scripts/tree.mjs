// Test helper: starts a grandchild that sleeps, prints both PIDs, then behaves as asked.
//   node tree.mjs wait      -> keeps running (killed by the test)
//   node tree.mjs exit      -> exits at once; the grandchild keeps the inherited stdout pipe open
import { spawn } from 'child_process';

const mode = process.argv[2] ?? 'wait';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: mode === 'exit' ? 'inherit' : 'ignore' });
console.log(`child ${process.pid}`);
console.log(`grandchild ${grandchild.pid}`);
if (mode === 'exit') {
  process.exit(0);
}
setTimeout(() => {}, 120000);
