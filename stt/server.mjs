// Holds the ElevenLabs key so browsers never see it, and limits what a visitor can spend.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // about two minutes of Opus; hold-to-talk clips are seconds long
const MAX_PER_ADDRESS_PER_HOUR = Number(process.env.STT_MAX_PER_ADDRESS_PER_HOUR ?? 60);
const MAX_PER_DAY = Number(process.env.STT_MAX_PER_DAY ?? 500);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const apiKey = (process.env.ELEVENLABS_API_KEY_FILE
  ? readFileSync(process.env.ELEVENLABS_API_KEY_FILE, 'utf8')
  : process.env.ELEVENLABS_API_KEY ?? '').trim();
if (!apiKey) throw new Error('set ELEVENLABS_API_KEY_FILE or ELEVENLABS_API_KEY');

const hourly = new Map();
let daily = { start: Date.now(), count: 0 };

function allow(address) {
  const now = Date.now();
  if (now - daily.start > DAY) daily = { start: now, count: 0 };
  for (const [key, entry] of hourly) if (now - entry.start > HOUR) hourly.delete(key);
  const entry = hourly.get(address) ?? { start: now, count: 0 };
  if (daily.count >= MAX_PER_DAY || entry.count >= MAX_PER_ADDRESS_PER_HOUR) return false;
  daily.count += 1;
  entry.count += 1;
  hourly.set(address, entry);
  return true;
}

const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function sameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) {
        req.destroy();
        reject(new Error('too large'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function transcribe(audio, type) {
  const form = new FormData();
  form.set('model_id', 'scribe_v2');
  form.set('tag_audio_events', 'false');
  form.set('file', new Blob([audio], { type }), 'utterance.webm');
  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}`);
  const { text, language_code: language } = await response.json();
  return { text, language };
}

createServer(async (req, res) => {
  if (req.url === '/health') return reply(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/api/transcribe') return reply(res, 404, { error: 'not found' });
  if (!sameOrigin(req)) return reply(res, 403, { error: 'wrong origin' });
  // The last entry is the one our own proxy added; earlier ones are whatever the client claimed.
  const address = (req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop().trim();
  if (!allow(address)) return reply(res, 429, { error: 'too many requests' });

  let audio;
  try {
    audio = await readBody(req);
  } catch {
    return reply(res, 413, { error: 'recording too long' });
  }
  try {
    reply(res, 200, await transcribe(audio, req.headers['content-type'] ?? 'audio/webm'));
  } catch (error) {
    console.error(error.message);
    reply(res, 502, { error: 'transcription failed' });
  }
}).listen(PORT, () => console.log(`speech proxy listening on ${PORT}`));
