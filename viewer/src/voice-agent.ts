// Hold-to-talk from the headset to the VR agent running on the PC (`just vr-agent`).

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

  constructor(private show: (text: string, busy: boolean) => void) {
    this.connect();
  }

  private connect() {
    const socket = new WebSocket(AGENT_URL);
    this.socket = socket;
    // Asked here rather than on the first press: a permission prompt can't be answered from inside VR.
    socket.addEventListener('open', () => void this.askForMicrophone());
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as AgentMessage;
      this.show(message.text, message.type === 'status');
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
    if (!this.connected) return this.show('The VR agent is not running on the PC', false);
    if (!this.allowed) return this.show('No microphone access', false);
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
      if (performance.now() - this.startedAt < MIN_RECORDING_MS) return this.show('Hold the button while you speak', false);
      void this.transcribeAndSend(new Blob(chunks, { type: recorder.mimeType }));
    };
    this.recorder = recorder;
    this.startedAt = performance.now();
    recorder.start();
    this.show('Listening… release to send', true);
  }

  private async transcribeAndSend(audio: Blob) {
    this.show('Transcribing…', true);
    try {
      const response = await fetch('/api/transcribe', { method: 'POST', body: audio, headers: { 'content-type': audio.type } });
      if (!response.ok) return this.show(response.status === 429 ? 'Voice limit reached, try later' : 'Speech service failed', false);
      const { text } = await response.json() as { text: string };
      if (text.trim()) this.sendText(text.trim());
      else this.show('I did not catch that', false);
    } catch {
      this.show('Speech service unreachable', false);
    }
  }

  stopRecording() {
    this.held = false;
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recorder = null;
  }

  /** Same path as speech, minus the microphone. */
  sendText(text: string) {
    this.socket?.send(JSON.stringify({ text }));
  }
}
