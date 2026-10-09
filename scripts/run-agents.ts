/**
 * Starts several bot agents as separate processes (one per "machine"), so killing one
 * really is like a Notebook going down.
 *
 *   node dist/scripts/run-agents.js                 # bot-01 bot-02 bot-03
 *   node dist/scripts/run-agents.js bot-01 bot-02   # pick bots
 */
import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

const AGENT = join(__dirname, '..', 'agent', 'bot-agent.js');
// pnpm forwards a literal "--" (`pnpm agents -- bot-01`); it is not a bot id.
const picked = process.argv.slice(2).filter((a) => a !== '--');
const ids = picked.length ? picked : ['bot-01', 'bot-02', 'bot-03'];

const children: ChildProcess[] = ids.map((id, i) =>
  spawn(process.execPath, [AGENT, id, '--host', `NOTEBOOK-${String(i + 1).padStart(2, '0')}`], {
    stdio: 'inherit',
  }),
);

for (const [i, child] of children.entries()) {
  child.on('exit', (code) => console.log(`[run-agents] ${ids[i]} exited with code ${code}`));
}

const shutdown = () => {
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 1000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
