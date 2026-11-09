import type { OpenedDocument } from './model';
import type { AgentQuery, CommandResult, DocumentCommand, DocumentSummary, ModelEvent, TextReplacement } from './worker-protocol';

type ToolRequest = { type: 'tool'; id: string; name: string; args: Record<string, unknown> };
type ToolTrace = {
  browser_ms: number; swap_ms?: number; revision_before?: number; revision_after?: number;
  phases?: Record<string, number>; class_delta?: Record<string, number>;
};
type ToolReply = { type: 'result'; id: string; result?: unknown; error?: string; trace: ToolTrace };
type Edit = OpenedDocument & { command: CommandResult };

/** How many past opens a newly connected bridge gets: enough to show what led up to a failure. */
const MODEL_EVENT_REPLAY = 20;

const queryMethods = new Set(['model_overview', 'find_elements', 'get_element', 'context_around', 'get_focus', 'list_materials', 'kit_help']);

/** Timing and class counts belong in the trace; the model would only pay tokens to read them. */
function splitTraceFields(result: unknown): { visible: unknown; traced: Pick<ToolTrace, 'phases' | 'class_delta'> } {
  if (!result || typeof result !== 'object' || !('timing' in result)) return { visible: result, traced: {} };
  const { timing, class_delta, ...visible } = result as { timing?: Record<string, number>; class_delta?: Record<string, number> };
  return { visible, traced: { phases: timing, class_delta } };
}

export function connectAgent(options: {
  port: number;
  document: () => DocumentSummary | null;
  modelEvents: readonly ModelEvent[];
  onModelEvent: (listener: (event: ModelEvent) => void) => () => void;
  changed: (opened: OpenedDocument, summary: string, ids: number[]) => Promise<void>;
  status: (message: string) => void;
  query: (query: AgentQuery) => Promise<unknown>;
  execute: (document: DocumentSummary, command: DocumentCommand, title?: string) => Promise<Edit>;
  revision: (action: 'undo' | 'redo', document: DocumentSummary) => Promise<Edit>;
  revise: (document: DocumentSummary, edit: { editId: string; values: Record<string, unknown>; replacements: TextReplacement[] }) => Promise<Edit>;
}): { disconnect: () => void; call: (name: string, args: Record<string, unknown>) => Promise<unknown> } {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry: number | null = null;

  const reply = (message: ToolReply) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
  const sendModelEvent = (event: ModelEvent) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'model', event }));
  const stopModelEvents = options.onModelEvent(sendModelEvent);

  const call = async (name: string, args: Record<string, unknown>, timing: { swap_ms?: number } = {}): Promise<unknown> => {
    if (queryMethods.has(name)) return options.query({ method: name, params: args } as AgentQuery);
    const document = options.document();
    if (!document) throw new Error('no browser project is open');
    const publish = async (changed: Edit) => {
      const swapping = performance.now();
      await options.changed(changed, changed.command.summary, changed.command.changed);
      timing.swap_ms = Math.round(performance.now() - swapping);
      return changed.command;
    };
    if (name === 'undo' || name === 'redo') return publish(await options.revision(name, document));
    const values = (args.params ?? {}) as Record<string, unknown>;
    if (name === 'revise_edit') {
      return publish(await options.revise(document, {
        editId: String(args.edit_id), values, replacements: (args.replacements ?? []) as TextReplacement[],
      }));
    }
    if (name === 'run_ifcopenshell' && args.commit === false) {
      return options.query({ method: 'inspect_with_script', params: { code: String(args.code), values } });
    }

    let command: DocumentCommand;
    const targets = (args.elements as string[] | undefined ?? [args.element as string]).filter(Boolean)
      .map((value) => value.startsWith('#') ? { expressID: Number(value.slice(1)) } : { globalId: value });
    if (name === 'run_ifcopenshell') {
      command = { kind: 'script', targets: [], params: { code: String(args.code), summary: String(args.summary), values } };
    } else if (name === 'set_name') {
      command = { kind: 'setName', targets, params: { name: String(args.name) } };
    } else if (name === 'set_attribute') {
      command = {
        kind: 'setAttribute', targets,
        params: { attribute: String(args.attribute), value: args.value as string | number | boolean | null },
      };
    } else if (name === 'set_property') {
      command = {
        kind: 'setProperty', targets,
        params: { pset: String(args.pset), name: String(args.name), value: args.value as string | number | boolean },
      };
    } else if (name === 'resize_door_or_window') {
      command = {
        kind: 'resizeFilling', targets,
        params: {
          width: args.width == null ? undefined : Number(args.width),
          height: args.height == null ? undefined : Number(args.height),
          anchor: 'center',
        },
      };
    } else if (name === 'move_elements') {
      command = {
        kind: 'moveElements', targets,
        params: { x: Number(args.x ?? 0), y: Number(args.y ?? 0), z: Number(args.z ?? 0) },
      };
    } else if (name === 'delete_elements') {
      command = { kind: 'deleteElements', targets, params: { confirmationToken: String(args.confirmation_token ?? '') } };
    } else {
      throw new Error(`unsupported browser tool ${name}`);
    }

    return publish(await options.execute(document, command, typeof args.title === 'string' ? args.title : undefined));
  };

  const handle = async (request: ToolRequest) => {
    const started = performance.now();
    const revision_before = options.document()?.revision;
    const timing: { swap_ms?: number } = {};
    const trace = (): ToolTrace => ({
      browser_ms: Math.round(performance.now() - started), ...timing, revision_before, revision_after: options.document()?.revision,
    });
    try {
      const { visible, traced } = splitTraceFields(await call(request.name, request.args, timing));
      reply({ type: 'result', id: request.id, result: visible, trace: { ...trace(), ...traced } });
    } catch (error) {
      reply({ type: 'result', id: request.id, error: error instanceof Error ? error.message : String(error), trace: trace() });
    }
  };

  const open = () => {
    if (stopped) return;
    // A failed first load leaves no document, and is exactly what the trace needs to hear about.
    if (!options.document() && options.modelEvents.every((event) => event.ok)) {
      retry = window.setTimeout(open, 500);
      return;
    }
    socket = new WebSocket(`ws://127.0.0.1:${options.port}`);
    socket.addEventListener('open', () => {
      if (options.document()) options.status('Claude bridge connected');
      options.modelEvents.slice(-MODEL_EVENT_REPLAY).forEach(sendModelEvent);
    });
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
  return {
    call,
    disconnect: () => {
      stopped = true;
      stopModelEvents();
      if (retry != null) clearTimeout(retry);
      socket?.close();
    },
  };
}
