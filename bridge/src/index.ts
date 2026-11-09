import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, type WebSocket } from 'ws';
import * as z from 'zod/v4';
import { createTrace } from './trace.js';

type ToolOutcome = { result?: unknown; error?: string; trace?: Record<string, unknown> };
type BrowserReply = ToolOutcome & { type: 'result'; id: string };
type BrowserModelEvent = { type: 'model'; event: Record<string, unknown> };
type Pending = { settle: (outcome: ToolOutcome) => void; timer: NodeJS.Timeout };

let browser: WebSocket | null = null;
const pending = new Map<string, Pending>();
const trace = createTrace('bridge');

const port = Number(process.env.TAKO_BRIDGE_PORT ?? 47831);
const webSocketServer = new WebSocketServer({ host: '127.0.0.1', port });
webSocketServer.on('connection', (socket, request) => {
  const origin = request.headers.origin ?? '';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    socket.close(1008, 'tako accepts only a local browser');
    return;
  }
  if (browser?.readyState === 1) {
    socket.close(1013, 'another tako tab is already paired');
    return;
  }
  browser = socket;
  socket.on('message', (data) => {
    let reply: BrowserReply | BrowserModelEvent;
    try { reply = JSON.parse(String(data)) as BrowserReply | BrowserModelEvent; } catch { return; }
    if (reply.type === 'model') {
      trace.write('model', reply.event);
      return;
    }
    if (reply.type !== 'result') return;
    const call = pending.get(reply.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(reply.id);
    call.settle(reply);
  });
  socket.on('close', () => {
    if (browser === socket) browser = null;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.settle({ error: 'the tako browser tab disconnected' });
      pending.delete(id);
    }
  });
});

function callBrowser(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!browser || browser.readyState !== browser.OPEN) {
    return Promise.resolve({ error: 'No tako browser tab is connected. Open http://localhost:5173 and import or open an IFC project.' });
  }
  const id = randomUUID();
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      settle({ error: `browser tool ${name} timed out` });
    }, 300_000);
    pending.set(id, { settle, timer });
    browser!.send(JSON.stringify({ type: 'tool', id, name, args }));
  });
}

async function callTraced(name: string, args: Record<string, unknown>): Promise<unknown> {
  const started = performance.now();
  const { result, error, trace: browserTrace } = await callBrowser(name, args);
  trace.write('tool', {
    tool: name, args, ms: Math.round(performance.now() - started), ok: !error, error,
    result_bytes: JSON.stringify(result)?.length ?? 0, ...browserTrace,
  });
  if (error) throw new Error(error);
  return result;
}

const server = new McpServer({ name: 'tako-ifc', version: '0.2.0' }, {
  instructions: `Edit the IFC building open in the user's tako browser. Resolve references with find_elements and context_around; do not rely on authoring-tool names. Facts report their source. Use get_focus for "this" and follow-up context. Prefer the dedicated tools; for anything else, use context_around and kit_help first, then run_ifcopenshell with the kit. Follow-ups on the latest edit use revise_edit. All lengths are metres. The browser owns the model and revisions.`,
});

const ok = (result: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });
const tool = <S extends z.ZodRawShape>(name: string, description: string, schema: S) =>
  server.tool(name, description, schema, (async (args: Record<string, unknown>) =>
    ok(await callTraced(name, args))) as never);

const title = z.string().max(60).optional().describe('Short name for this revision, shown in the VR revision list. Describe the design change, e.g. "Wider entrance door".');

tool('model_overview', 'Schema, storeys, element counts and recent browser-local edit history.', {});
tool('find_elements', 'Find candidates by IFC class and derived spatial facts. Inspect source fields before relying on inferred exterior/facing.', {
  ifc_class: z.string().optional(), storey: z.string().optional(), exterior: z.boolean().optional(),
  facing: z.string().optional(), text: z.string().optional(),
  sort_by: z.enum(['width', 'height', 'length', 'north', 'south', 'east', 'west']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
tool('get_element', 'Inspect one element by #expressID or GlobalId, including its relations: opening, host, openings and type.', { element: z.string() });
tool('context_around', 'Describe an element and nearby building elements.', {
  target: z.string(), radius: z.number().positive().default(3), limit: z.number().int().min(1).max(100).default(40),
});
tool('get_focus', 'Return the element selected in the browser, with its relations (opening, host, openings, type), and the latest edit.', {});
tool('list_materials', 'List materials found on rendered products and their usage counts.', {});
tool('set_name', 'Set the IFC Name of one or more elements as one atomic browser revision.', {
  elements: z.array(z.string()).min(1), name: z.string().min(1),
  title,
});
tool('set_attribute', 'Set an existing simple IFC attribute. This cannot change relationships or geometry.', {
  elements: z.array(z.string()).min(1), attribute: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  title,
});
tool('set_property', 'Set an existing single-value property. Refuses missing property sets rather than creating an invalid graph.', {
  element: z.string(), pset: z.string().min(1), name: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]),
  title,
});
tool('resize_door_or_window', 'Resize mapped door/window geometry and its host opening. Inputs are metres; only center anchoring is currently supported.', {
  element: z.string(), width: z.number().positive().optional(), height: z.number().positive().optional(),
  anchor: z.literal('center').default('center'),
  title,
});
tool('move_elements', 'Move products by a metre offset in IFC x/y/z coordinates as one revision.', {
  elements: z.array(z.string()).min(1), x: z.number().default(0), y: z.number().default(0), z: z.number().default(0),
  title,
});
tool('delete_elements', 'Delete elements and direct relationships. Deleting a door or window also removes its opening, so the wall closes; no need to list the opening. Requires the literal confirmation token CONFIRM_DELETE after user approval.', {
  elements: z.array(z.string()).min(1), confirmation_token: z.literal('CONFIRM_DELETE'),
  title,
});
tool('run_ifcopenshell', 'Run Python against the open model, for any edit or question no other tool covers. Names available: f (ifcopenshell.file), si (SpatialIndex: si.facts[id] has world bbox, storey, exterior, host; si.rooms has the IfcSpaces. The first read for a model state tessellates the whole model and can take minutes, so use get_focus or get_element for one element and keep si for whole-model questions. It describes the model as the script started, so read it before changing anything), kit (building blocks in metres; see kit_help), ifcopenshell, api (ifcopenshell.api), ue (ifcopenshell.util.element), PARAMS. Assign a list of changed expressIDs to `changed` so the viewer highlights them and they are verified. Print to return output. The model is rolled back if the code raises. Use commit=false for read-only inspection. Put sizes and options in params and read them from PARAMS, so a follow-up can change them with revise_edit.', {
  code: z.string().min(1), summary: z.string().min(1).describe('What the edit did.'),
  commit: z.boolean().default(true), params: z.record(z.string(), z.unknown()).optional(),
  title,
});
tool('kit_help', 'Reference for the kit used in run_ifcopenshell. No topic: all functions and example names. A topic: one function\'s docs, or a complete worked example. Read the matching example before writing a modelling script.', {
  topic: z.string().optional(),
});
tool('revise_edit', 'Redo the latest edit with changes instead of undoing and starting over; it stays one undo step. Use for follow-ups like "only the left side" or "make it wider".', {
  edit_id: z.string().describe('commandId from the edit result, or latest_edit.commandId from get_focus.'),
  params: z.record(z.string(), z.unknown()).optional().describe('Parameters to change; others keep their values.'),
  replacements: z.array(z.object({ old: z.string(), new: z.string() })).optional().describe('Script edits only; each old text must occur exactly once.'),
});
tool('undo', 'Move the browser project back one revision.', {});
tool('redo', 'Move the browser project forward one revision.', {});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`tako MCP bridge ready on ws://127.0.0.1:${port}`);
