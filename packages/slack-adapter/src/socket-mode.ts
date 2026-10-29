// Slack Socket Mode over Node's built-in WebSocket client. No public URL needed.
import { SlackApi } from './slack-api.ts';

export interface Envelope {
  envelope_id: string;
  type: 'events_api' | 'slash_commands' | 'interactive' | string;
  payload: Record<string, any>;
  retry_attempt?: number;
}

export interface SocketModeOptions {
  appToken: string;
  baseUrl?: string;
  /** Return an optional ack payload (slash commands can reply inline). */
  onEnvelope: (e: Envelope) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class SocketModeClient {
  private o: SocketModeOptions;
  private api: SlackApi;
  private ws?: WebSocket;
  private stopped = false;
  private attempt = 0;
  constructor(o: SocketModeOptions) {
    this.o = o;
    this.api = new SlackApi({ token: o.appToken, baseUrl: o.baseUrl });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { url } = await this.api.call<{ url: string }>('apps.connections.open');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => { this.attempt = 0; this.o.log?.('socket mode connected'); });
    ws.addEventListener('message', (m) => { void this.onMessage(ws, String(m.data)); });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = undefined;
      if (!this.stopped) this.reconnect();
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }

  private reconnect(): void {
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.o.log?.('socket mode reconnecting', { delay_ms: delay });
    setTimeout(() => { if (!this.stopped) this.connect().catch(() => this.reconnect()); }, delay).unref();
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: Envelope & { reason?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') return;
    if (msg.type === 'disconnect') {
      // Slack rotates connections; open a fresh one, then let this one close.
      this.o.log?.('socket mode disconnect requested', { reason: msg.reason });
      this.connect().catch(() => this.reconnect());
      return;
    }
    if (!msg.envelope_id) return;
    let payload: Record<string, unknown> | void = undefined;
    try { payload = await this.o.onEnvelope(msg); } catch (e) { this.o.log?.('envelope handler failed', { err: String(e) }); }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload ? { envelope_id: msg.envelope_id, payload } : { envelope_id: msg.envelope_id }));
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
