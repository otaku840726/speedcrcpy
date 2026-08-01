import { MAX_TEMPLATE_BASE64 } from "@speedcrcpy/shared";
import { AdbServerClient } from "@yume-chan/adb";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AdbManager } from "../adb/adb-manager.js";
import { AUTH_COOKIE, type Auth } from "../auth.js";
import { saveConfig } from "../config.js";
import type { DeviceStatsManager } from "../scrcpy/device-stats.js";
import type { DisplayManager } from "../scrcpy/display-override.js";
import type { SessionManager } from "../scrcpy/session-manager.js";
import type { ScriptEngine } from "../scripts/engine.js";
import type { Scheduler } from "../scripts/scheduler.js";
import type { DraftStore } from "../scripts/draft-store.js";
import type { ReplayStore } from "../scripts/replay-store.js";
import type { ScriptStore } from "../scripts/store.js";
import { captureScreenshot } from "../scrcpy/screenshot.js";
import { ocrModel } from "../scripts/ocr.js";
import { findTemplate, recognize, visionStatus } from "../scripts/vision-offload.js";
import { memoryBlocks } from "../scripts/vision-health.js";
import { capture, framePng } from "../scripts/vision.js";
import type { ThumbnailManager } from "../scrcpy/thumbnail-manager.js";
import { readFile } from "node:fs/promises";
import { BUILT_AT, VERSION } from "../version.js";

const LoginBody = z.object({ password: z.string() });
const AddressBody = z.object({ address: z.string().min(3) });
const PairBody = z.object({ address: z.string().min(3), code: z.string().min(1) });
const AutoConnectBody = z.object({ address: z.string().min(3), autoConnect: z.boolean() });
const KickBody = z.object({ viewerId: z.string().optional(), serial: z.string().optional() });
const ScriptKeyEnum = z.enum(["back", "home", "recents", "power", "wake", "volumeUp", "volumeDown"]);
const norm = z.coerce.number().min(0).max(1);
const HexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/);
const Timeout = z.coerce.number().int().min(0).max(600_000);
const RegionSchema = z.object({ x: norm, y: norm, w: norm, h: norm });
/** Base64 PNG, plus the size it was captured at. */
const TemplateSchema = z.object({
  png: z.string().min(1).max(MAX_TEMPLATE_BASE64),
  capturedWidth: z.coerce.number().int().min(1).max(8192),
  capturedHeight: z.coerce.number().int().min(1).max(8192),
});
const FilterSchema = z
  .object({
    mode: z.enum(["contains", "standalone", "exact"]).optional(),
    minConfidence: norm.optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    colorTolerance: norm.optional(),
    minHeight: norm.optional(),
    maxHeight: norm.optional(),
  })
  .optional();
const PickSchema = z
  .object({
    by: z.enum(["reading", "left", "right", "top", "bottom", "score", "random", "nearest", "farthest"]).optional(),
    refX: norm.optional(),
    refY: norm.optional(),
    index: z.coerce.number().int().min(0).max(50).optional(),
    expect: z.enum(["any", "one"]).optional(),
  })
  .optional();
/** Every step carries an off switch, so it has to be on every member below:
 * zod strips unknown keys rather than rejecting them, so leaving it off one
 * member would drop the flag on save and that step would quietly come back on. */
const offSwitch = { disabled: z.boolean().optional() };
/** Step tree — recursive because `loop` nests a body. */
const StepSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("tap"), x: norm, y: norm, ...offSwitch }),
    z.object({ type: z.literal("swipe"), x1: norm, y1: norm, x2: norm, y2: norm, durationMs: z.coerce.number().int().min(1).max(60_000), ...offSwitch }),
    z.object({ type: z.literal("wait"), minMs: z.coerce.number().int().min(0).max(600_000), maxMs: z.coerce.number().int().min(0).max(600_000), ...offSwitch }),
    z.object({ type: z.literal("text"), value: z.string().max(1000), ...offSwitch }),
    z.object({ type: z.literal("key"), key: ScriptKeyEnum, ...offSwitch }),
    z.object({ type: z.literal("loop"), count: z.coerce.number().int().min(0).max(1_000_000), body: z.array(StepSchema).max(200), ...offSwitch }),
    z.object({ type: z.literal("waitColor"), x: norm, y: norm, color: HexColor, tolerance: norm, timeoutMs: Timeout, ...offSwitch }),
    z.object({
      type: z.literal("ifColor"),
      x: norm,
      y: norm,
      color: HexColor,
      tolerance: norm,
      then: z.array(StepSchema).max(200),
      else: z.array(StepSchema).max(200).optional(),
      ...offSwitch,
    }),
    z.object({
      type: z.literal("findTap"),
      template: TemplateSchema,
      threshold: norm,
      timeoutMs: Timeout,
      region: RegionSchema.optional(),
      offsetX: z.coerce.number().min(-1).max(1).optional(),
      offsetY: z.coerce.number().min(-1).max(1).optional(),
      occurrence: z.coerce.number().int().min(0).max(50).optional(),
      filter: FilterSchema,
      pick: PickSchema,
      ...offSwitch,
    }),
    z.object({
      type: z.literal("tapText"),
      text: z.string().min(1).max(100),
      region: RegionSchema.optional(),
      timeoutMs: Timeout,
      occurrence: z.coerce.number().int().min(0).max(50).optional(),
      filter: FilterSchema,
      pick: PickSchema,
      offsetX: z.coerce.number().min(-1).max(1).optional(),
      offsetY: z.coerce.number().min(-1).max(1).optional(),
      ...offSwitch,
    }),
    z.object({
      type: z.literal("ifText"),
      text: z.string().min(1).max(100),
      region: RegionSchema.optional(),
      then: z.array(StepSchema).max(200),
      else: z.array(StepSchema).max(200).optional(),
      ...offSwitch,
    }),
    z.object({
      type: z.literal("ifNumber"),
      region: RegionSchema.optional(),
      compare: z.enum([">", ">=", "<", "<=", "=="]),
      value: z.coerce.number(),
      then: z.array(StepSchema).max(200),
      else: z.array(StepSchema).max(200).optional(),
      ...offSwitch,
    }),
    z.object({
      type: z.literal("ifImage"),
      template: TemplateSchema,
      threshold: norm,
      region: RegionSchema.optional(),
      then: z.array(StepSchema).max(200),
      else: z.array(StepSchema).max(200).optional(),
      ...offSwitch,
    }),
  ]),
);
const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("persistent") }),
  z.object({ type: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
]);
const ScriptBody = z.object({
  devices: z.array(z.string().min(1).max(200)).max(50).default([]),
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  steps: z.array(StepSchema).max(200),
  trigger: TriggerSchema.default({ type: "manual" }),
  priority: z.coerce.number().int().min(0).max(100).default(20),
  enabled: z.boolean().default(true),
});

/** Preview images are only for eyeballing position; coordinates stay normalized. */
const PREVIEW_WIDTH = 720;
/**
 * Ceiling on a probe. A screencap costs ~350 ms on an idle device but 4-9 s
 * while a game renders, and recognition adds its own seconds on top — long
 * enough that a reverse proxy may give up first and answer 502 with no body,
 * which tells the person at the keyboard nothing. Failing here instead produces
 * an error that names the step that ran long.
 */
const PROBE_TIMEOUT_MS = 25_000;

/** Does any template in this body blow the size cap? Walks the whole thing
 * because a script nests steps inside loops and branches. */
function hasOversizeTemplate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOversizeTemplate);
  if (!value || typeof value !== "object") return false;
  const png = (value as { template?: { png?: unknown } }).template?.png;
  if (typeof png === "string" && png.length > MAX_TEMPLATE_BASE64) return true;
  return Object.values(value).some(hasOversizeTemplate);
}

/** A body that failed validation only because its template is enormous should
 * say so: "bad_request" sends the author looking through their step settings
 * for a fault that is really the size of the marquee they dragged. */
function rejectInvalid(reply: FastifyReply, body: unknown) {
  return hasOversizeTemplate(body)
    ? reply.code(413).send({ error: "圖像太大,請重新框選小一點的範圍" })
    : reply.code(400).send({ error: "bad_request" });
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超過 ${PROBE_TIMEOUT_MS / 1000} 秒未完成`)), PROBE_TIMEOUT_MS).unref(),
    ),
  ]);
}
/** `text` is optional: supply it and the probe also reports where a tap for
 * that text would land, refined to the matching words. */
const OcrProbeBody = z.object({ region: RegionSchema.optional(), text: z.string().max(100).optional() });
const MatchProbeBody = z.object({
  template: TemplateSchema,
  region: RegionSchema.optional(),
  /** Supply it and the probe also lists every match, so the editor can show the
   * author what the choices are instead of just the single best one. */
  threshold: z.number().min(0).max(1).optional(),
});

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
  scriptStore: ScriptStore,
  draftStore: DraftStore,
  replayStore: ReplayStore,
  scriptEngine: ScriptEngine,
  scheduler: Scheduler,
): void {
  // Unauthenticated (see the auth hook exemption) so deployment tooling can
  // poll which build is live without a token. `version` is the git SHA.
  // `ocr` is here so a silent fall back to the bundled PP-OCRv4 — which reads
  // traditional Chinese wrongly but never errors — is visible from outside.
  app.get("/api/health", async () => ({
    ok: true,
    version: VERSION,
    builtAt: BUILT_AT,
    ocr: ocrModel(),
    // Growth here is what breaks text recognition after hours of running, and
    // it used to be invisible from outside the container. A block at 1024 MB is
    // a WebAssembly heap at its ceiling — see vision-health.ts.
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      externalMb: Math.round(process.memoryUsage().external / 1048576),
      blocksMb: memoryBlocks().map((b) => b.mb),
      vision: visionStatus(),
    },
  }));

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

  // ---- automation scripts ----

  /** Full-resolution screenshot for the script editor's coordinate/colour/template
   * pickers (the device-card thumbnail is deliberately tiny). */
  app.get<{ Params: { serial: string } }>("/api/devices/:serial/screenshot", async (request, reply) => {
    try {
      const png = await captureScreenshot(await adbManager.getAdb(request.params.serial));
      return reply.header("Content-Type", "image/png").header("Cache-Control", "no-store").send(png);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "capture_failed" });
    }
  });

  /** Every script, on every device — a script belongs to no one phone. */
  app.get("/api/scripts", async () => scriptStore.list());

  app.post("/api/scripts", async (request, reply) => {
    const body = ScriptBody.safeParse(request.body);
    if (!body.success) return rejectInvalid(reply, request.body);
    const saved = scriptStore.save(body.data as never);
    // Editing a script is a fresh intent — in particular, re-enabling one that
    // was stopped should let it be scheduled again.
    for (const serial of saved.devices) scheduler.resume(saved.id, serial);
    return saved;
  });

  app.delete<{ Params: { id: string } }>("/api/scripts/:id", async (request, reply) => {
    // The draft goes with the script; leaving it behind would offer to restore
    // edits to something that no longer exists.
    draftStore.delete(request.params.id);
    return scriptStore.delete(request.params.id) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  // ---- replay ----
  //
  // A rolling timelapse of each device, built from screenshots taken for other
  // reasons (the thumbnail loop while idle, a script's own captures while one
  // runs). Read-only apart from the recording settings.

  app.get<{ Params: { serial: string }; Querystring: { from?: string; to?: string } }>(
    "/api/devices/:serial/replay",
    async (request) => {
      const to = Number(request.query.to) || Date.now();
      const from = Number(request.query.from) || 0;
      return {
        ...replayStore.window(request.params.serial, from, to),
        settings: replayStore.current(),
        usedBytes: replayStore.usage(),
      };
    },
  );

  /** One frame, addressed by when it was taken. Immutable once written, so
   * scrubbing back and forth never re-fetches. */
  app.get<{ Params: { serial: string; at: string } }>("/api/devices/:serial/replay/:at", async (request, reply) => {
    const path = replayStore.framePath(request.params.serial, Number(request.params.at));
    if (!path) return reply.code(404).send({ error: "not_found" });
    try {
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .send(await readFile(path));
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  const ReplaySettingsBody = z.object({
    enabled: z.boolean(),
    intervalSec: z.coerce.number().min(0.2).max(60),
    maxMb: z.coerce.number().int().min(10).max(20_000),
  });

  app.put("/api/replays/settings", async (request, reply) => {
    const body = ReplaySettingsBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const settings = { ...replayStore.current(), ...body.data };
    replayStore.configure(settings);
    // Persisted next to the password so the choice survives a restart; merged
    // rather than rewritten, since that file is not ours alone.
    saveConfig({
      replayEnabled: settings.enabled,
      replayInterval: settings.intervalSec,
      replayMaxMb: settings.maxMb,
    });
    return { ...settings, usedBytes: replayStore.usage() };
  });

  // ---- drafts ----
  //
  // An edit in progress, kept server-side so it survives a reload, a closed
  // panel, or moving to another browser. Stored as sent: a draft is half
  // finished by nature, so the script schema would reject exactly the states
  // worth keeping. What is still enforced is size — the same template ceiling
  // as everywhere else, since a draft carries the same images.

  /** Script ids are uuids; an unsaved script uses a `new:<uuid>` key. */
  const DRAFT_KEY = /^(new:)?[a-zA-Z0-9-]{1,64}$/;

  /** Keys only. The editor asks this on every open just to know which scripts
   * have unsaved edits, and a draft body carries its image templates — several
   * MB that nobody asked for yet. Bodies come one at a time, below. */
  app.get("/api/drafts", async () => draftStore.list().map(({ key, updatedAt }) => ({ key, updatedAt })));

  app.get<{ Params: { key: string } }>("/api/drafts/:key", async (request, reply) => {
    const draft = draftStore.get(request.params.key);
    return draft ?? reply.code(404).send({ error: "not_found" });
  });

  app.put<{ Params: { key: string } }>("/api/drafts/:key", async (request, reply) => {
    if (!DRAFT_KEY.test(request.params.key)) return reply.code(400).send({ error: "bad_request" });
    const body = request.body;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "bad_request" });
    if (hasOversizeTemplate(body)) return reply.code(413).send({ error: "圖像太大,請重新框選小一點的範圍" });
    return draftStore.put(request.params.key, body, Date.now());
  });

  app.delete<{ Params: { key: string } }>("/api/drafts/:key", async (request) => {
    draftStore.delete(request.params.key);
    // Idempotent: discarding twice, or saving a script that never had a draft,
    // is not a failure worth reporting to the editor.
    return { ok: true };
  });

  /** Run on the device the caller is looking at, whatever the script's own
   * scheduled devices are — pressing 執行 means "here, now". */
  app.post<{ Params: { id: string; serial: string } }>("/api/devices/:serial/scripts/:id/run", async (request, reply) => {
    const script = scriptStore.get(request.params.id);
    if (!script) return reply.code(404).send({ error: "not_found" });
    scheduler.requestRun(script, request.params.serial);
    return { ok: true };
  });

  app.get("/api/schedule", async () => scheduler.overview());

  /** Try OCR on a region now, so the editor can show what the engine will read
   * (stylised fonts get characters wrong, so authors match on what comes back). */
  app.post<{ Params: { serial: string } }>("/api/devices/:serial/ocr", async (request, reply) => {
    const body = OcrProbeBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const frame = await withTimeout(capture(await adbManager.getAdb(request.params.serial)), "擷取畫面");
      thumbnails.offer(request.params.serial, frame);
      const result = await withTimeout(recognize(frame, body.data.region, body.data.text || undefined), "文字辨識");
      return {
        ...result,
        frameWidth: frame.width,
        frameHeight: frame.height,
        // The exact frame this ran on, so the editor's boxes line up.
        preview: framePng(frame, PREVIEW_WIDTH).toString("base64"),
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "ocr_failed" });
    }
  });

  /** Try template matching now: where it matched, how well, and against what. */
  app.post<{ Params: { serial: string } }>("/api/devices/:serial/match", async (request, reply) => {
    const body = MatchProbeBody.safeParse(request.body ?? {});
    if (!body.success) return rejectInvalid(reply, request.body);
    try {
      const frame = await withTimeout(capture(await adbManager.getAdb(request.params.serial)), "擷取畫面");
      thumbnails.offer(request.params.serial, frame);
      const started = Date.now();
      const template = body.data.template;
      const match = await withTimeout(
        findTemplate(frame, Buffer.from(template.png, "base64"), body.data.region, body.data.threshold),
        "找圖比對",
      );
      const ms = Date.now() - started;

      // Crop what it actually matched, so the author can eyeball whether the
      // "best match" is the right thing at all — a score alone can mislead.
      const crop = framePng(frame, 240, {
        x: (match.x - match.w / 2) * frame.width,
        y: (match.y - match.h / 2) * frame.height,
        w: match.w * frame.width,
        h: match.h * frame.height,
      }).toString("base64");

      return {
        ...match,
        ms,
        frameWidth: frame.width,
        frameHeight: frame.height,
        preview: framePng(frame, PREVIEW_WIDTH).toString("base64"),
        crop,
        // Template matching is not scale-invariant; a size change usually breaks it.
        scaleMismatch:
          template.capturedWidth > 0 &&
          (template.capturedWidth !== frame.width || template.capturedHeight !== frame.height)
            ? { captured: `${template.capturedWidth}×${template.capturedHeight}`, now: `${frame.width}×${frame.height}` }
            : null,
        // A little below the observed score, so normal variation still passes.
        suggestedThreshold: Math.max(0.5, Math.min(0.95, Math.round((match.score - 0.07) * 20) / 20)),
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "match_failed" });
    }
  });

  app.post<{ Params: { serial: string } }>("/api/devices/:serial/script/stop", async (request) => {
    scheduler.cancel(request.params.serial);
    return { ok: true };
  });

  app.get<{ Params: { serial: string } }>("/api/devices/:serial/script/status", async (request) => {
    const serial = request.params.serial;
    const status = scriptEngine.status(serial);
    const queued = scheduler.pending(serial);
    return {
      ...status,
      pending: queued
        ? { ...queued, scriptName: scriptStore.get(queued.scriptId)?.name ?? "" }
        : null,
    };
  });
}

function describeAdbError(error: unknown): string {
  if (error instanceof AdbServerClient.UnauthorizedError) return "unauthorized";
  if (error instanceof AdbServerClient.NetworkError) return "network";
  if (error instanceof Error) return error.message === "timeout" ? "network" : error.message;
  return "unknown";
}
