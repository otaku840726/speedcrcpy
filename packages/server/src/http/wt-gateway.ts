import { Http3Server } from "@fails-components/webtransport";
import { randomBytes } from "node:crypto";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import type { SessionManager } from "../scrcpy/session-manager.js";
import type { WtCert } from "../transport/wt-cert.js";
import { Viewer } from "../transport/viewer.js";
import { WtSink, type WtBidiStream, type WtSession } from "../transport/wt-sink.js";

/** The single path all WebTransport sessions connect to; serial+token ride the first control frame. */
const WT_PATH = "/wt/session";

interface WtServerSession extends WtSession {
  readonly ready: Promise<void>;
  readonly incomingBidirectionalStreams: ReadableStream<WtBidiStream>;
}

interface Http3ServerLike {
  startServer(): void;
  stopServer(): Promise<void>;
  readonly ready: Promise<void>;
  sessionStream(path: string): Promise<ReadableStream<WtServerSession>>;
}

/**
 * WebTransport (HTTP/3) gateway — the QUIC counterpart to `WsGateway`. Each
 * incoming session's first control frame carries `{serial, token}`; once the
 * token verifies and the device session is acquired, a `Viewer` is wired to a
 * `WtSink` exactly as the WS path wires it to a `WsSink`.
 */
export class WtGateway {
  private readonly server: Http3ServerLike;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly sessionManager: SessionManager,
    cert: WtCert,
  ) {
    this.server = new Http3Server({
      port: config.wtPort,
      host: config.host,
      secret: randomBytes(32).toString("hex"),
      cert: cert.certPem,
      privKey: cert.keyPem,
    }) as unknown as Http3ServerLike;
  }

  async start(): Promise<void> {
    this.server.startServer();
    await this.server.ready;
    this.running = true;
    void this.acceptLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.server.stopServer().catch(() => {});
  }

  private async acceptLoop(): Promise<void> {
    const stream = await this.server.sessionStream(WT_PATH);
    const reader = stream.getReader();
    while (this.running) {
      const { value: session, done } = await reader.read();
      if (done) break;
      if (session) void this.handleSession(session);
    }
  }

  private async handleSession(session: WtServerSession): Promise<void> {
    try {
      await session.ready;
      const bidiReader = session.incomingBidirectionalStreams.getReader();
      const { value: control } = await bidiReader.read();
      if (!control) {
        session.close();
        return;
      }

      const sink = new WtSink(session, control, (serial, token) => {
        if (!this.auth.verify(token) || !serial) {
          sink.close();
          return;
        }
        this.sessionManager
          .acquire(serial)
          .then((managed) => new Viewer(sink, managed).attach())
          .catch((error: unknown) => {
            console.error(`[wt] failed to start ${serial}:`, error instanceof Error ? error.message : error);
            sink.close();
          });
      });
    } catch (error) {
      console.warn(`[wt] session setup failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        session.close();
      } catch {
        /* already gone */
      }
    }
  }
}
