// Lets a headset talk to Claude: requests come in over a WebSocket, Claude edits through its own tako bridge.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocketServer, type WebSocket } from 'ws';
import { createTrace } from './trace.js';

const AGENT_PORT = 47832;
/** The viewer also connects here, so this agent doesn't collide with a desktop Claude session on 47831. */
const BRIDGE_PORT = 47833;
const ROOT = join(import.meta.dirname, '../..');

const SYSTEM_PROMPT = `The user is standing inside this building wearing a VR headset and speaks short requests, transcribed by speech recognition, so expect transcription slips. "This" or "that" means the element they point at: use get_focus. They cannot read long text or answer questions easily, so make a sensible assumption and act. Do not delete anything unless they explicitly asked for it. End with one plain sentence of at most 12 words saying what changed. No markdown.`;

const TOOL_STATUS: Record<string, string> = {
  run_ifcopenshell: 'Editing the model…', revise_edit: 'Revising the edit…', kit_help: 'Reading the kit…',
  get_focus: 'Looking at what you pointed at…', find_elements: 'Searching the model…', context_around: 'Looking around it…',
};

type Outgoing = { type: 'status' | 'reply' | 'error'; text: string };
type Speech = { record_ms: number; transcribe_ms: number };

const trace = createTrace('vr-agent');
let client: WebSocket | null = null;
let busy = false;
const send = (message: Outgoing) => {
  console.log(`[${message.type}] ${message.text}`);
  if (client?.readyState === 1) client.send(JSON.stringify(message));
};

// --- speech proxy (the deployed site runs this as its own container) ----------------
const speechProxy = spawn('node', [join(ROOT, 'stt/server.mjs')], { stdio: 'inherit' });

// --- Claude --------------------------------------------------------------------
let claude: ChildProcessWithoutNullStreams | null = null;

function startClaude() {
  const mcpConfig = JSON.stringify({
    mcpServers: { 'tako-ifc': { command: 'node', args: [join(ROOT, 'bridge/dist/index.js')], env: { TAKO_BRIDGE_PORT: String(BRIDGE_PORT), TAKO_TRACE_FILE: trace.file } } },
  });
  const started = spawn('claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    // Nobody can answer a permission prompt from inside the headset, so Claude gets the tako tools and nothing else.
    '--tools', '', '--allowedTools', 'mcp__tako-ifc__*',
    '--append-system-prompt', SYSTEM_PROMPT,
  ], { cwd: ROOT });
  started.stderr.on('data', (data) => process.stderr.write(data));
  createInterface({ input: started.stdout }).on('line', handleClaudeLine);
  started.on('exit', (code) => {
    trace.write('exit', { code });
    if (claude === started) claude = null;
    if (busy) send({ type: 'error', text: `Claude stopped (exit ${code})` });
    busy = false;
  });
  claude = started;
}

function handleClaudeLine(line: string) {
  let event: { type?: string; subtype?: string; result?: string; message?: { content?: Array<{ type: string; name?: string }> } };
  try { event = JSON.parse(line); } catch { return; }
  trace.write('claude', { data: event });
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') send({ type: 'status', text: TOOL_STATUS[(block.name ?? '').replace('mcp__tako-ifc__', '')] ?? 'Working…' });
    }
  } else if (event.type === 'result') {
    busy = false;
    if (event.subtype === 'success') send({ type: 'reply', text: event.result?.trim() || 'Done.' });
    else send({ type: 'error', text: `Claude could not finish (${event.subtype})` });
  }
}

function prompt(text: string, speech?: Speech) {
  if (!claude) startClaude();
  busy = true;
  trace.write('request', { text, ...speech });
  send({ type: 'status', text: `Heard: ${text}` });
  claude!.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
}

// --- headset connection ------------------------------------------------------------
const server = new WebSocketServer({ host: '127.0.0.1', port: AGENT_PORT });
server.on('connection', (socket, request) => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.origin ?? '')) {
    socket.close(1008, 'tako accepts only a local browser');
    return;
  }
  client = socket;
  console.log('viewer connected');
  socket.on('message', (data) => {
    if (busy) return send({ type: 'error', text: 'Still working on the last request' });
    const { text, speech } = JSON.parse(String(data)) as { text: string; speech?: Speech };
    prompt(text, speech);
  });
});

startClaude();
console.log(`tako VR agent listening on ws://127.0.0.1:${AGENT_PORT}`);

const stop = () => {
  claude?.kill();
  speechProxy.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
