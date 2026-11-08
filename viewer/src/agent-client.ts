import type { OpenedDocument } from './model';
import type { AgentQuery, CommandResult, DocumentCommand, DocumentSummary } from './worker-protocol';

type ToolRequest = { type: 'tool'; id: string; name: string; args: Record<string, unknown> };
type ToolReply = { type: 'result'; id: string; result?: unknown; error?: string };

const queryMethods = new Set(['model_overview', 'find_elements', 'get_element', 'context_around', 'get_focus', 'list_materials']);

export function connectAgent(options: {
  document: () => DocumentSummary | null;
  changed: (opened: OpenedDocument, summary: string, ids: number[]) => Promise<void>;
  status: (message: string) => void;
  query: (query: AgentQuery) => Promise<unknown>;
  execute: (document: DocumentSummary, command: DocumentCommand) => Promise<OpenedDocument & { command: CommandResult }>;
  revision: (action: 'undo' | 'redo', document: DocumentSummary) => Promise<OpenedDocument & { command: CommandResult }>;
}): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry: number | null = null;

  const reply = (message: ToolReply) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

  const handle = async (request: ToolRequest) => {
    try {
      if (queryMethods.has(request.name)) {
        const result = await options.query({ method: request.name, params: request.args } as AgentQuery);
        return reply({ type: 'result', id: request.id, result });
      }
      const document = options.document();
      if (!document) throw new Error('no browser project is open');
      if (request.name === 'undo' || request.name === 'redo') {
        const changed = await options.revision(request.name, document);
        await options.changed(changed, changed.command.summary, changed.command.changed);
        return reply({ type: 'result', id: request.id, result: changed.command });
      }

      let command: DocumentCommand;
      const targets = (request.args.elements as string[] | undefined ?? [request.args.element as string]).filter(Boolean)
        .map((value) => value.startsWith('#') ? { expressID: Number(value.slice(1)) } : { globalId: value });
      if (request.name === 'set_name') {
        command = { kind: 'setName', targets, params: { name: String(request.args.name) } };
      } else if (request.name === 'set_attribute') {
        command = {
          kind: 'setAttribute', targets,
          params: { attribute: String(request.args.attribute), value: request.args.value as string | number | boolean | null },
        };
      } else if (request.name === 'set_property') {
        command = {
          kind: 'setProperty', targets,
          params: { pset: String(request.args.pset), name: String(request.args.name), value: request.args.value as string | number | boolean },
        };
      } else if (request.name === 'resize_door_or_window') {
        command = {
          kind: 'resizeFilling', targets,
          params: {
            width: request.args.width == null ? undefined : Number(request.args.width),
            height: request.args.height == null ? undefined : Number(request.args.height),
            anchor: 'center',
          },
        };
      } else if (request.name === 'move_elements') {
        command = {
          kind: 'moveElements', targets,
          params: { x: Number(request.args.x ?? 0), y: Number(request.args.y ?? 0), z: Number(request.args.z ?? 0) },
        };
      } else if (request.name === 'delete_elements') {
        command = { kind: 'deleteElements', targets, params: { confirmationToken: String(request.args.confirmation_token ?? '') } };
      } else {
        throw new Error(`unsupported browser tool ${request.name}`);
      }
      const changed = await options.execute(document, command);
      await options.changed(changed, changed.command.summary, changed.command.changed);
      reply({ type: 'result', id: request.id, result: changed.command });
    } catch (error) {
      reply({ type: 'result', id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const open = () => {
    if (stopped) return;
    if (!options.document()) {
      retry = window.setTimeout(open, 500);
      return;
    }
    socket = new WebSocket('ws://127.0.0.1:47831');
    socket.addEventListener('open', () => options.status('Claude bridge connected'));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ToolRequest;
      if (message.type === 'tool') void handle(message);
    });
    socket.addEventListener('close', () => {
      if (!stopped) retry = window.setTimeout(open, 1500);
    });
    socket.addEventListener('error', () => socket?.close());
  };
  open();
  return () => {
    stopped = true;
    if (retry != null) clearTimeout(retry);
    socket?.close();
  };
}
