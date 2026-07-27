import { AdbServerClient } from "@yume-chan/adb";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdbManager } from "../adb/adb-manager.js";
import { AUTH_COOKIE, type Auth } from "../auth.js";
import type { DeviceStatsManager } from "../scrcpy/device-stats.js";
import type { DisplayManager } from "../scrcpy/display-override.js";
import type { SessionManager } from "../scrcpy/session-manager.js";
import type { ThumbnailManager } from "../scrcpy/thumbnail-manager.js";
import { BUILT_AT, VERSION } from "../version.js";

const LoginBody = z.object({ password: z.string() });
const AddressBody = z.object({ address: z.string().min(3) });
const PairBody = z.object({ address: z.string().min(3), code: z.string().min(1) });
const AutoConnectBody = z.object({ address: z.string().min(3), autoConnect: z.boolean() });
const KickBody = z.object({ viewerId: z.string().optional(), serial: z.string().optional() });
const DisplayBody = z.object({
  reset: z.boolean().optional(),
  width: z.coerce.number().int().min(100).max(5000).optional(),
  height: z.coerce.number().int().min(100).max(5000).optional(),
  density: z.coerce.number().int().min(60).max(1000).optional(),
});

export function registerRoutes(
  app: FastifyInstance,
  auth: Auth,
  adbManager: AdbManager,
  thumbnails: ThumbnailManager,
  stats: DeviceStatsManager,
  sessionManager: SessionManager,
  displayManager: DisplayManager,
): void {
  // Unauthenticated (see the auth hook exemption) so deployment tooling can
  // poll which build is live without a token. `version` is the git SHA.
  app.get("/api/health", async () => ({ ok: true, version: VERSION, builtAt: BUILT_AT }));

  app.post("/api/login", async (request, reply) => {
    const body = LoginBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const result = auth.login(body.data.password, request.ip);
    if ("error" in result) {
      return reply.code(result.error === "rate_limited" ? 429 : 401).send({ error: result.error });
    }

    reply.setCookie(AUTH_COOKIE, result.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60,
    });
    return { ok: true, token: result.token };
  });

  app.get("/api/me", async () => ({ ok: true }));

  app.get("/api/devices", async () => adbManager.deviceInfos());

  app.post("/api/devices/connect", async (request, reply) => {
    const body = AddressBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      await adbManager.connect(body.data.address);
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: describeAdbError(error) });
    }
  });

  app.post("/api/devices/pair", async (request, reply) => {
    const body = PairBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      await adbManager.pair(body.data.address, body.data.code);
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: describeAdbError(error) });
    }
  });

  app.post("/api/devices/disconnect", async (request, reply) => {
    const body = AddressBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await adbManager.disconnect(body.data.address);
    return { ok: true };
  });

  app.post("/api/devices/forget", async (request, reply) => {
    const body = AddressBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await adbManager.forget(body.data.address);
    return { ok: true };
  });

  app.post("/api/devices/auto-connect", async (request, reply) => {
    const body = AutoConnectBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    adbManager.setAutoConnect(body.data.address, body.data.autoConnect);
    return { ok: true };
  });

  app.get<{ Params: { serial: string } }>("/api/devices/:serial/thumbnail", async (request, reply) => {
    const serial = request.params.serial;
    const info = adbManager.deviceInfos().find((d) => d.serial === serial);
    if (!info || info.state !== "device") return reply.code(404).send({ error: "not_available" });

    const png = await thumbnails.get(serial);
    if (!png) return reply.code(503).send({ error: "capture_failed" });
    return reply.header("Content-Type", "image/png").header("Cache-Control", "no-store").send(png);
  });

  app.get<{ Params: { serial: string } }>("/api/devices/:serial/stats", async (request, reply) => {
    const cached = stats.get(request.params.serial);
    // 204 until the first poll lands so the client shows placeholders, not stale data.
    if (!cached) return reply.code(204).send();
    return reply.header("Cache-Control", "no-store").send(cached);
  });

  // Active viewer connections across all sessions.
  app.get("/api/sessions", async () => sessionManager.listConnections());

  // Evict a viewer by id, or every viewer of a device by serial.
  app.post("/api/sessions/kick", async (request, reply) => {
    const body = KickBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.viewerId) {
      const ok = await sessionManager.kick(body.data.viewerId);
      return ok ? { ok: true, kicked: 1 } : reply.code(404).send({ error: "not_found" });
    }
    if (body.data.serial) {
      const kicked = await sessionManager.kickDevice(body.data.serial);
      return { ok: true, kicked };
    }
    return reply.code(400).send({ error: "bad_request" });
  });

  // Device display resolution/density (wm size / wm density) override.
  app.get<{ Params: { serial: string } }>("/api/devices/:serial/display", async (request, reply) => {
    try {
      return await displayManager.info(request.params.serial);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "read_failed" });
    }
  });

  app.post<{ Params: { serial: string } }>("/api/devices/:serial/display", async (request, reply) => {
    const body = DisplayBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const serial = request.params.serial;
    try {
      if (body.data.reset) {
        await displayManager.reset(serial);
      } else {
        const { width, height, density } = body.data;
        if (width == null || height == null || density == null) return reply.code(400).send({ error: "bad_request" });
        await displayManager.apply(serial, { width, height, density });
      }
      // Nudge the live session (if any) to re-read the resized display.
      await sessionManager.pokeVideo(serial);
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "apply_failed" });
    }
  });
}

function describeAdbError(error: unknown): string {
  if (error instanceof AdbServerClient.UnauthorizedError) return "unauthorized";
  if (error instanceof AdbServerClient.NetworkError) return "network";
  if (error instanceof Error) return error.message === "timeout" ? "network" : error.message;
  return "unknown";
}
