import { AdbServerClient } from "@yume-chan/adb";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdbManager } from "../adb/adb-manager.js";
import { AUTH_COOKIE, type Auth } from "../auth.js";

const LoginBody = z.object({ password: z.string() });
const AddressBody = z.object({ address: z.string().min(3) });
const PairBody = z.object({ address: z.string().min(3), code: z.string().min(1) });
const AutoConnectBody = z.object({ address: z.string().min(3), autoConnect: z.boolean() });

export function registerRoutes(app: FastifyInstance, auth: Auth, adbManager: AdbManager): void {
  app.get("/api/health", async () => ({ ok: true }));

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
}

function describeAdbError(error: unknown): string {
  if (error instanceof AdbServerClient.UnauthorizedError) return "unauthorized";
  if (error instanceof AdbServerClient.NetworkError) return "network";
  if (error instanceof Error) return error.message === "timeout" ? "network" : error.message;
  return "unknown";
}
