import { AdbManager } from "./adb/adb-manager.js";
import { Auth } from "./auth.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./http/app.js";
import { registerSessionEndpoint } from "./http/session-endpoint.js";
import { registerEventsEndpoint, WsGateway } from "./http/ws.js";
import { WtGateway } from "./http/wt-gateway.js";
import { DeviceStatsManager } from "./scrcpy/device-stats.js";
import { DisplayManager } from "./scrcpy/display-override.js";
import { ScreenManager } from "./scrcpy/screen-manager.js";
import { SessionManager } from "./scrcpy/session-manager.js";
import { ThumbnailManager } from "./scrcpy/thumbnail-manager.js";
import { ScriptEngine } from "./scripts/engine.js";
import { ScriptStore } from "./scripts/store.js";
import { loadOrCreateWtCert } from "./transport/wt-cert.js";

// Safety net: the app runs many concurrent adb/scrcpy streams. A single
// device dropping (EPIPE on a closed adb socket, a scrcpy stream ending
// mid-read) throws asynchronously; without this, Node turns it into a fatal
// crash that kills EVERY device session and viewer. Log and stay up — errors
// are isolated per session and the affected session tears itself down.
process.on("unhandledRejection", (reason) => {
  const err = reason as { code?: string; message?: string };
  console.warn(`[process] unhandled rejection (${err?.code ?? "?"}): ${err?.message ?? String(reason)}`);
});
process.on("uncaughtException", (error) => {
  console.warn(`[process] uncaught exception (${(error as { code?: string }).code ?? "?"}): ${error.message}`);
});

const config = loadConfig();
const auth = new Auth(config.dataDir, config.password);

const adbManager = new AdbManager(config);
const screenManager = new ScreenManager(adbManager, config.screenOffDefault);
const thumbnailManager = new ThumbnailManager(adbManager, config.thumbnailInterval * 1000);
const statsManager = new DeviceStatsManager(adbManager, config.statsInterval * 1000);
const displayManager = new DisplayManager(adbManager, config.dataDir);
const scriptStore = new ScriptStore(config.dataDir);
const scriptEngine = new ScriptEngine(adbManager);
const sessionManager = new SessionManager(
  adbManager,
  config.screenOffDefault,
  config.sessionLinger * 1000,
  config.videoCodec,
  (serial, active) => screenManager.setSessionActive(serial, active),
  displayManager,
);
const app = await buildApp(config, auth, adbManager, thumbnailManager, statsManager, sessionManager, displayManager, scriptStore, scriptEngine);

const gateway = new WsGateway(app, auth);
registerEventsEndpoint(gateway, adbManager);
registerSessionEndpoint(gateway, sessionManager);

// Optional WebTransport gateway (HTTP/3). When enabled, clients that support
// it connect over QUIC; everyone else stays on WebSocket. The cert hash is
// advertised so browsers can trust the self-signed cert.
let wtGateway: WtGateway | undefined;
let wtInfo: { enabled: boolean; port: number; certHash: string | null } = {
  enabled: false,
  port: config.wtPort,
  certHash: null,
};
if (config.wtEnabled) {
  try {
    const cert = await loadOrCreateWtCert(config.dataDir);
    wtGateway = new WtGateway(config, auth, sessionManager, cert);
    await wtGateway.start();
    wtInfo = { enabled: true, port: config.wtPort, certHash: cert.hashBase64 };
    app.log.info(`WebTransport gateway ready on udp/${config.wtPort}`);
  } catch (error) {
    app.log.error(`WebTransport gateway failed to start: ${error instanceof Error ? error.message : error}`);
  }
}
// Authed (the global /api/ hook already verified the caller). A fresh token
// is minted for the client to put in its WebTransport attach frame — the QUIC
// connection carries no auth cookie.
app.get("/api/wt-info", async () => ({ ...wtInfo, token: wtInfo.enabled ? auth.issue() : null }));

// Listen before starting the adb tracker: Tango's device-track socket is
// unref'd, so it must not be the only thing keeping the process alive.
await app.listen({ host: config.host, port: config.port });
await adbManager.start();
screenManager.start();
thumbnailManager.start();
statsManager.start();

app.log.info(`speedcrcpy server ready on ${config.host}:${config.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  thumbnailManager.stop();
  statsManager.stop();
  await wtGateway?.stop().catch(() => {});
  await sessionManager.closeAll().catch(() => {});
  await screenManager.stop().catch(() => {});
  await adbManager.stop().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
