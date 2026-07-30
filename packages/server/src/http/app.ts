import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdbManager } from "../adb/adb-manager.js";
import { AUTH_COOKIE, type Auth } from "../auth.js";
import type { Config } from "../config.js";
import type { DeviceStatsManager } from "../scrcpy/device-stats.js";
import type { DisplayManager } from "../scrcpy/display-override.js";
import type { SessionManager } from "../scrcpy/session-manager.js";
import type { ScriptEngine } from "../scripts/engine.js";
import type { Scheduler } from "../scripts/scheduler.js";
import type { DraftStore } from "../scripts/draft-store.js";
import type { ScriptStore } from "../scripts/store.js";
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
  displayManager: DisplayManager,
  scriptStore: ScriptStore,
  draftStore: DraftStore,
  scriptEngine: ScriptEngine,
  scheduler: Scheduler,
): Promise<FastifyInstance> {
  // Fastify defaults to a 1 MiB body, which a template probe cannot fit inside:
  // an image template is cropped at full device resolution and travels as
  // base64 (a 4/3 inflation), and a saved script carries every template it
  // uses. Reproduced at 1.2 MB — FST_ERR_CTP_BODY_TOO_LARGE.
  //
  // Templates cannot be shrunk to dodge this: template matching is not
  // scale-invariant, so a downscaled template stops matching the full-size
  // screen it is searched against. The limit is what has to move. A single
  // template is still capped (MAX_TEMPLATE_BASE64) so one mis-drag cannot claim
  // the whole ceiling; this leaves room for several of them in one script.
  const app = Fastify({ logger: { level: "info" }, bodyLimit: 16 * 1024 * 1024 });
  await app.register(fastifyCookie);

  // A body over that ceiling is refused by Fastify before any route runs, and
  // its stock reply says "Payload Too Large" in English with no hint of which
  // part of the app is at fault. Every other error keeps its default handling.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "傳送的內容太大 — 通常是圖像模板,請重新框選小一點的範圍" });
    }
    request.log.error(error);
    return reply.send(error);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url === "/api/login" || request.url === "/api/health") return;
    if (!auth.verify(tokenFromRequest(request))) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  registerRoutes(app, auth, adbManager, thumbnails, stats, sessionManager, displayManager, scriptStore, draftStore, scriptEngine, scheduler);

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
