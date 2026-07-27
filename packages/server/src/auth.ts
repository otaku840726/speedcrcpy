import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const FAIL_WINDOW_MS = 60_000;
const MAX_FAILS_PER_WINDOW = 5;

export class Auth {
  private readonly secret: Buffer;
  private readonly failures = new Map<string, number[]>();

  constructor(
    dataDir: string,
    private readonly password: string,
  ) {
    const secretPath = join(dataDir, "secret");
    if (existsSync(secretPath)) {
      this.secret = Buffer.from(readFileSync(secretPath, "utf8").trim(), "hex");
    } else {
      this.secret = randomBytes(32);
      writeFileSync(secretPath, this.secret.toString("hex"), { mode: 0o600 });
    }
  }

  /** Returns a token on success, null on wrong password or rate limit. */
  login(password: string, ip: string): { token: string } | { error: "rate_limited" | "bad_password" } {
    const now = Date.now();
    const fails = (this.failures.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (fails.length >= MAX_FAILS_PER_WINDOW) return { error: "rate_limited" };

    const expected = Buffer.from(this.password);
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      fails.push(now);
      this.failures.set(ip, fails);
      return { error: "bad_password" };
    }

    this.failures.delete(ip);
    return { token: this.mint() };
  }

  /**
   * Mint a fresh token for an already-authenticated request. Used to hand the
   * WebTransport client a token it can put in its attach frame — the QUIC
   * connection carries no auth cookie, unlike the WS upgrade.
   */
  issue(): string {
    return this.mint();
  }

  private mint(): string {
    const exp = (Date.now() + TOKEN_TTL_MS).toString(16);
    return `${exp}.${this.sign(exp)}`;
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const [exp, mac] = token.split(".");
    if (!exp || !mac) return false;
    if (parseInt(exp, 16) < Date.now()) return false;
    const expected = Buffer.from(this.sign(exp));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

export const AUTH_COOKIE = "sc_token";
