import { encodeJsonFrame, type EventsMessage } from "@speedcrcpy/shared";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AdbManager } from "../adb/adb-manager.js";
import { AUTH_COOKIE, type Auth } from "../auth.js";

export function tokenFromUpgrade(request: IncomingMessage): string | undefined {
  const cookies = request.headers.cookie ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === AUTH_COOKIE) return decodeURIComponent(rest.join("="));
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get("token") ?? undefined;
}

type WsHandler = (ws: WebSocket, request: IncomingMessage, url: URL) => void;

/**
 * Authenticated WebSocket gateway. Routes are exact pathnames, or prefix
 * routes ending in "/*" (e.g. "/ws/session/*").
 */
export class WsGateway {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly routes = new Map<string, WsHandler>();

  constructor(app: FastifyInstance, auth: Auth) {
    app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const handler = this.match(url.pathname);
      if (!handler) {
        socket.destroy();
        return;
      }
      if (!auth.verify(tokenFromUpgrade(request))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        // Low-latency: never batch small frames behind Nagle's algorithm.
        (ws as WebSocket & { _socket?: { setNoDelay?: (v: boolean) => void } })._socket?.setNoDelay?.(true);
        handler(ws, request, url);
      });
    });
  }

  add(route: string, handler: WsHandler): void {
    this.routes.set(route, handler);
  }

  private match(pathname: string): WsHandler | undefined {
    const exact = this.routes.get(pathname);
    if (exact) return exact;
    for (const [route, handler] of this.routes) {
      if (route.endsWith("/*") && pathname.startsWith(route.slice(0, -1))) return handler;
    }
    return undefined;
  }
}

export function registerEventsEndpoint(gateway: WsGateway, adbManager: AdbManager): void {
  gateway.add("/ws/events", (ws) => {
    const send = () => {
      const message: EventsMessage = { type: "devices", devices: adbManager.deviceInfos() };
      ws.send(encodeJsonFrame(message));
    };

    send();
    const unsubscribe = adbManager.onDevicesChange(() => send());
    ws.on("close", unsubscribe);
    ws.on("error", () => {
      unsubscribe();
      ws.close();
    });
  });
}
