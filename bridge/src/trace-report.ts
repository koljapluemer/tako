// Summarises one trace per request: where the time went, tokens, and PASS/FAIL for benchmark cases.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRACE_DIR = join(import.meta.dirname, '../../work/traces');
const CASES = join(import.meta.dirname, '../benchmark/cases.json');

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type Event = {
  ts: string; event: string; text?: string; record_ms?: number; transcribe_ms?: number;
  tool?: string; ms?: number; ok?: boolean; browser_ms?: number; swap_ms?: number; publish_ms?: number;
  revision_before?: number; revision_after?: number; phases?: Record<string, number>; class_delta?: Record<string, number>;
  data?: { type?: string; duration_ms?: number; duration_api_ms?: number; total_cost_usd?: number; usage?: Usage };
};
type Case = { id: string; text: string; expect: { revisions: number; class_delta?: Record<string, number> } };

/** The same element can be stored under a standard-case class, depending on the schema and authoring tool. */
const canonicalClass = (name: string) => (name === 'IfcOpeningStandardCase' ? 'IfcOpeningElement' : name.replace(/StandardCase$/, ''));

function judge(expected: Case['expect'], tools: Event[]): string[] {
  const revisioned = tools.filter((tool) => tool.revision_before != null && tool.revision_after != null);
  const revisions = revisioned.length ? revisioned.at(-1)!.revision_after! - revisioned[0]!.revision_before! : 0;
  const problems = revisions === expected.revisions ? [] : [`revisions ${revisions}, expected ${expected.revisions}`];
  const delta: Record<string, number> = {};
  for (const tool of tools) {
    for (const [name, change] of Object.entries(tool.class_delta ?? {})) delta[canonicalClass(name)] = (delta[canonicalClass(name)] ?? 0) + change;
  }
  for (const [name, change] of Object.entries(expected.class_delta ?? {})) {
    if ((delta[name] ?? 0) !== change) problems.push(`${name} ${delta[name] ?? 0}, expected ${change}`);
  }
  return problems;
}

function report(request: Event, rest: Event[], cases: Case[]) {
  const tools = rest.filter((event) => event.event === 'tool');
  const result = rest.find((event) => event.data?.type === 'result')?.data;
  const lastTs = rest.at(-1)?.ts ?? request.ts;
  const total = result?.duration_ms ?? Date.parse(lastTs) - Date.parse(request.ts);
  const toolMs = tools.reduce((sum, tool) => sum + (tool.ms ?? 0), 0);

  console.log(`\n"${request.text}"`);
  const speech = request.record_ms != null ? `, speech ${request.record_ms + (request.transcribe_ms ?? 0)} ms before this` : '';
  console.log(`  total ${total} ms: tools ${toolMs} ms, model ${result?.duration_api_ms ?? '?'} ms${speech}`);
  for (const tool of tools) {
    const swap = tool.swap_ms ?? tool.publish_ms;
    const phases = Object.entries({ ...tool.phases, ...(swap != null && { swap_ms: swap }) }).map(([name, ms]) => `${name} ${ms}`).join(', ');
    console.log(`  ${tool.ok ? ' ' : '!'} ${tool.tool} ${tool.ms} ms${phases ? ` (${phases})` : ''}`);
  }
  if (result?.usage) {
    const { input_tokens: input = 0, cache_creation_input_tokens: written = 0, cache_read_input_tokens: read = 0, output_tokens: output = 0 } = result.usage;
    console.log(`  tokens: input ${input}, cache write ${written}, cache read ${read}, output ${output}; $${result.total_cost_usd?.toFixed(3) ?? '?'} at list price`);
  }
  const benchmark = cases.find((item) => item.text === request.text);
  if (benchmark) {
    const problems = judge(benchmark.expect, tools);
    console.log(`  ${benchmark.id}: ${problems.length ? `FAIL (${problems.join('; ')})` : 'PASS'}`);
  }
}

const newest = () => {
  const name = readdirSync(TRACE_DIR).filter((file) => file.endsWith('.jsonl')).sort().at(-1);
  if (!name) throw new Error(`no traces in ${TRACE_DIR}`);
  return join(TRACE_DIR, name);
};

const file = process.argv[2] ?? newest();
const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Event);
const cases = JSON.parse(readFileSync(CASES, 'utf8')) as Case[];
const starts = events.flatMap((event, index) => (event.event === 'request' ? [index] : []));

console.log(file);
starts.forEach((start, position) => report(events[start]!, events.slice(start + 1, starts[position + 1] ?? events.length), cases));
