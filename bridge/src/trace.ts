// Append-only record of agent sessions, for benchmarking and finding bottlenecks: one JSONL file per session in work/traces.
//
// Every line has ts, session, source and event. The events are:
//   tool     (bridge)   one MCP tool call: tool, args, ms, ok, error, result_bytes, and from the browser
//                       browser_ms, swap_ms (scene swap and project picker refresh, after geometry is built),
//                       revision_before, revision_after, phases (ms per edit or script phase), class_delta (entity count change per IFC class)
//   model    (bridge)   one attempt to open a model in web-ifc: at (when the browser did it), reason, ok, ms, bytes, opened, closed, heap_bytes, error
//   request  (vr-agent) one spoken or typed request: text, record_ms, transcribe_ms
//   claude   (vr-agent) one raw Claude stream event: data
//   reset    (vr-agent) Claude was restarted so the next request starts without context
//   exit     (vr-agent) the Claude process stopped: code
// doc/agent-tracing.md explains how to read them.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TRACE_DIR = join(import.meta.dirname, '../../work/traces');

const newTraceFile = () => join(TRACE_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`);

/** A process that sets TAKO_TRACE_FILE for its children shares one timeline with them. */
export function createTrace(source: 'bridge' | 'vr-agent') {
  const file = process.env.TAKO_TRACE_FILE ?? newTraceFile();
  const session = basename(file, '.jsonl');
  return {
    file,
    write(event: string, fields: Record<string, unknown>) {
      // A trace that can't be written must never cost the user an edit.
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), session, source, event, ...fields })}\n`);
      } catch (error) {
        console.error('tako trace write failed', error);
      }
    },
  };
}
