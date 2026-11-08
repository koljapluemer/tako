import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, type WebSocket } from 'ws';
import * as z from 'zod/v4';

type BrowserReply = { type: 'result'; id: string; result?: unknown; error?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

let browser: WebSocket | null = null;
const pending = new Map<string, Pending>();

const webSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 47831 });
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
    let reply: BrowserReply;
    try { reply = JSON.parse(String(data)) as BrowserReply; } catch { return; }
    if (reply.type !== 'result') return;
    const call = pending.get(reply.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(reply.id);
    if (reply.error) call.reject(new Error(reply.error));
    else call.resolve(reply.result);
  });
  socket.on('close', () => {
    if (browser === socket) browser = null;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new Error('the tako browser tab disconnected'));
      pending.delete(id);
    }
  });
});

function callBrowser(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!browser || browser.readyState !== browser.OPEN) {
    throw new Error('No tako browser tab is connected. Open http://localhost:5173 and import or open an IFC project.');
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser tool ${name} timed out`));
    }, 120_000);
    pending.set(id, { resolve, reject, timer });
    browser!.send(JSON.stringify({ type: 'tool', id, name, args }));
  });
}

const server = new McpServer({ name: 'tako-ifc', version: '0.2.0' }, {
  instructions: `Edit the IFC building open in the user's tako browser. Resolve references with find_elements and context_around; do not rely on authoring-tool names. Facts report their source. Use get_focus for "this" and follow-up context. All lengths are metres. The browser owns the model and revisions.`,
});

const ok = (result: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
const tool = <S extends z.ZodRawShape>(name: string, description: string, schema: S) =>
  server.tool(name, description, schema, (async (args: Record<string, unknown>) =>
    ok(await callBrowser(name, args))) as never);

const title = z.string().max(60).optional().describe('Short name for this revision, shown in the VR revision list. Describe the design change, e.g. "Wider entrance door".');

tool('model_overview', 'Schema, storeys, element counts and recent browser-local edit history.', {});
tool('find_elements', 'Find candidates by IFC class and derived spatial facts. Inspect source fields before relying on inferred exterior/facing.', {
  ifc_class: z.string().optional(), storey: z.string().optional(), exterior: z.boolean().optional(),
  facing: z.string().optional(), text: z.string().optional(),
  sort_by: z.enum(['width', 'height', 'length', 'north', 'south', 'east', 'west']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
tool('get_element', 'Inspect one element by #expressID or GlobalId.', { element: z.string() });
tool('context_around', 'Describe an element and nearby building elements.', {
  target: z.string(), radius: z.number().positive().default(3), limit: z.number().int().min(1).max(100).default(40),
});
tool('get_focus', 'Return the element selected in the browser and the latest edit.', {});
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
tool('delete_elements', 'Delete elements and direct relationships. Requires the literal confirmation token CONFIRM_DELETE after user approval.', {
  elements: z.array(z.string()).min(1), confirmation_token: z.literal('CONFIRM_DELETE'),
  title,
});
tool('undo', 'Move the browser project back one revision.', {});
tool('redo', 'Move the browser project forward one revision.', {});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('tako MCP bridge ready on ws://127.0.0.1:47831');
