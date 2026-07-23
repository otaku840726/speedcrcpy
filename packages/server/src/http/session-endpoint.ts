import { encodeJsonFrame } from "@speedcrcpy/shared";
import type { SessionManager } from "../scrcpy/session-manager.js";
import { Viewer } from "../transport/viewer.js";
import type { WsGateway } from "./ws.js";

export function registerSessionEndpoint(gateway: WsGateway, sessionManager: SessionManager): void {
  gateway.add("/ws/session/*", (ws, _request, url) => {
    const serial = decodeURIComponent(url.pathname.slice("/ws/session/".length));
    if (!serial) {
      ws.close();
      return;
    }

    sessionManager
      .acquire(serial)
      .then((session) => {
        if (ws.readyState !== ws.OPEN) return;
        new Viewer(ws, session).attach();
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
