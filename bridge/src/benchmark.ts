// Sends every case in benchmark/cases.json to a running vr-agent, each with a fresh Claude. trace-report.ts judges the results.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const AGENT_URL = 'ws://127.0.0.1:47832';
const CASES = join(import.meta.dirname, '../benchmark/cases.json');
const RESET_DONE = 'Claude restarted';
/** Long enough for the new bridge to start and the viewer's 1.5 s reconnect to reach it. */
const RECONNECT_MS = 5_000;
const CASE_TIMEOUT_MS = 600_000;

type Incoming = { type: 'status' | 'reply' | 'error'; text: string };

const cases = JSON.parse(readFileSync(CASES, 'utf8')) as Array<{ id: string; text: string }>;
// The agent accepts only local browser origins.
const socket = new WebSocket(AGENT_URL, { origin: 'http://localhost' });
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

function waitFor(done: (message: Incoming) => boolean): Promise<Incoming> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the agent')), CASE_TIMEOUT_MS);
    const listen = (data: unknown) => {
      const message = JSON.parse(String(data)) as Incoming;
      if (!done(message)) return;
      clearTimeout(timer);
      socket.off('message', listen);
      resolve(message);
    };
    socket.on('message', listen);
  });
}

for (const { id, text } of cases) {
  const restarted = waitFor((message) => message.text === RESET_DONE);
  socket.send(JSON.stringify({ reset: true }));
  await restarted;
  await sleep(RECONNECT_MS);

  const started = performance.now();
  const finished = waitFor((message) => message.type !== 'status');
  socket.send(JSON.stringify({ text }));
  const { type, text: answer } = await finished;
  console.log(`${id}: ${type} after ${Math.round((performance.now() - started) / 1000)}s: ${answer}`);
}

socket.close();
console.log('done; run `just trace-report` for timings and PASS/FAIL');
