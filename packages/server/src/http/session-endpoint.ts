import { encodeJsonFrame } from "@speedcrcpy/shared";
import type { SessionManager } from "../scrcpy/session-manager.js";
import type { Scheduler } from "../scripts/scheduler.js";
import { Viewer } from "../transport/viewer.js";
import { WsSink } from "../transport/ws-sink.js";
import type { WsGateway } from "./ws.js";

export function registerSessionEndpoint(gateway: WsGateway, sessionManager: SessionManager, scheduler?: Scheduler): void {
  gateway.add("/ws/session/*", (ws, request, url) => {
    const serial = decodeURIComponent(url.pathname.slice("/ws/session/".length));
    if (!serial) {
      ws.close();
      return;
    }

    const forwarded = request.headers["x-forwarded-for"];
    const address =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ||
      request.socket.remoteAddress ||
      null;

    sessionManager
      .acquire(serial)
      .then((session) => {
        if (ws.readyState !== ws.OPEN) return;
        new Viewer(new WsSink(ws, address), session, scheduler).attach();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "session failed";
        console.error(`[session] failed to start for ${serial}:`, message);
        if (ws.readyState === ws.OPEN) {
          ws.send(encodeJsonFrame({ type: "error", message }));
          ws.close();
        }
      });
  });
}
