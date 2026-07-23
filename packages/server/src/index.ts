import { AdbManager } from "./adb/adb-manager.js";
import { Auth } from "./auth.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./http/app.js";
import { registerSessionEndpoint } from "./http/session-endpoint.js";
import { registerEventsEndpoint, WsGateway } from "./http/ws.js";
import { SessionManager } from "./scrcpy/session-manager.js";

const config = loadConfig();
const auth = new Auth(config.dataDir, config.password);

const adbManager = new AdbManager(config);
const sessionManager = new SessionManager(adbManager, config.screenOffDefault);
const app = await buildApp(config, auth, adbManager);

const gateway = new WsGateway(app, auth);
registerEventsEndpoint(gateway, adbManager);
registerSessionEndpoint(gateway, sessionManager);

// Listen before starting the adb tracker: Tango's device-track socket is
// unref'd, so it must not be the only thing keeping the process alive.
await app.listen({ host: config.host, port: config.port });
await adbManager.start();

app.log.info(`speedcrcpy server ready on ${config.host}:${config.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  await sessionManager.closeAll().catch(() => {});
  await adbManager.stop().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
