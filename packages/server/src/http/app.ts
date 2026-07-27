import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdbManager } from "../adb/adb-manager.js";
import { AUTH_COOKIE, type Auth } from "../auth.js";
import type { Config } from "../config.js";
import type { DeviceStatsManager } from "../scrcpy/device-stats.js";
import type { SessionManager } from "../scrcpy/session-manager.js";
import type { ThumbnailManager } from "../scrcpy/thumbnail-manager.js";
import { registerRoutes } from "./routes.js";

export function tokenFromRequest(request: FastifyRequest): string | undefined {
  const cookie = (request.cookies as Record<string, string | undefined>)[AUTH_COOKIE];
  if (cookie) return cookie;
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return undefined;
}

export async function buildApp(
  config: Config,
  auth: Auth,
  adbManager: AdbManager,
  thumbnails: ThumbnailManager,
  stats: DeviceStatsManager,
  sessionManager: SessionManager,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(fastifyCookie);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url === "/api/login" || request.url === "/api/health") return;
    if (!auth.verify(tokenFromRequest(request))) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  registerRoutes(app, auth, adbManager, thumbnails, stats, sessionManager);

  // In production the built web app is served by the server itself;
  // in development Vite serves it and proxies /api + /ws here.
  // The module dir differs between dev (src/http/) and the bundled build
  // (dist/), so probe both candidate locations of packages/web/dist.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const webDist = ["../../web/dist", "../../../web/dist"]
    .map((candidate) => join(moduleDir, candidate))
    .find((path) => existsSync(path));
  if (webDist) {
    // wildcard routing serves files resolved at request time — a rebuilt web
    // app (new hashed filenames) must not require a server restart.
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
        await reply.code(404).send({ error: "not_found" });
        return;
      }
      await reply.sendFile("index.html");
    });
  }

  return app;
}
