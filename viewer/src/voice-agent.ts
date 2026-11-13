// Hold-to-talk from the headset to the VR agent running on the PC (`just vr-agent`).
import { noticeKind, type NoticeKind } from './xr/feedback';

type AgentMessage = { type: 'status' | 'reply' | 'error'; text: string };

const AGENT_URL = 'ws://127.0.0.1:47832';
/** Shorter presses are accidental, and too short for speech recognition anyway. */
const MIN_RECORDING_MS = 350;

export class VoiceAgent {
  private socket: WebSocket | null = null;
  private allowed = false;
  private held = false;
  private recorder: MediaRecorder | null = null;
  private startedAt = 0;

  constructor(
    private show: (text: string, kind: NoticeKind) => void,
    /** What the user is doing in the scene, for the agent to read alongside the request. */
    private context: () => Promise<string | undefined> = async () => undefined,
  ) {
    this.connect();
  }

  private connect() {
    const socket = new WebSocket(AGENT_URL);
    this.socket = socket;
    // Asked here rather than on the first press: a permission prompt can't be answered from inside VR.
    socket.addEventListener('open', () => void this.askForMicrophone());
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as AgentMessage;
      this.show(message.text, noticeKind(message.type));
    });
    socket.addEventListener('close', () => window.setTimeout(() => this.connect(), 2000));
    socket.addEventListener('error', () => socket.close());
  }

  private async askForMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      this.allowed = true;
    } catch (error) {
      console.warn('microphone unavailable', error);
    }
  }

  private get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  startRecording() {
    if (!this.connected) return this.show('The VR agent is not running on the PC', 'error');
    if (!this.allowed) return this.show('No microphone access', 'error');
    this.held = true;
    void this.record();
  }

  /** Opens a new stream on every press: a stream opened before entering VR records silence on Quest. */
  private async record() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!this.held) return stream.getTracks().forEach((track) => track.stop());
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const recordMs = Math.round(performance.now() - this.startedAt);
      if (recordMs < MIN_RECORDING_MS) return this.show('Hold the button while you speak', 'info');
      void this.transcribeAndSend(new Blob(chunks, { type: recorder.mimeType }), recordMs);
    };
    this.recorder = recorder;
    this.startedAt = performance.now();
    recorder.start();
    this.show('Listening… release to send', 'working');
  }

  private async transcribeAndSend(audio: Blob, recordMs: number) {
    this.show('Transcribing…', 'working');
    const started = performance.now();
    try {
      const response = await fetch('/api/transcribe', { method: 'POST', body: audio, headers: { 'content-type': audio.type } });
      if (!response.ok) return this.show(response.status === 429 ? 'Voice limit reached, try later' : 'Speech service failed', 'error');
      const { text } = await response.json() as { text: string };
      if (text.trim()) void this.sendText(text.trim(), { record_ms: recordMs, transcribe_ms: Math.round(performance.now() - started) });
      else this.show('I did not catch that', 'error');
    } catch {
      this.show('Speech service unreachable', 'error');
    }
  }

  stopRecording() {
    this.held = false;
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recorder = null;
  }

  /** Same path as speech, minus the microphone. */
  async sendText(text: string, speech?: { record_ms: number; transcribe_ms: number }) {
    const context = await this.context().catch((error) => {
      console.warn('no interaction context', error);
      return undefined;
    });
    this.socket?.send(JSON.stringify({ text, speech, context }));
  }
}
