import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { X509Certificate, createHash, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// WebCrypto interop: the server tsconfig has no DOM lib, so the WebCrypto type
// names (Crypto/CryptoKeyPair/EcKeyGenParams) aren't global. We rely on
// call-site inference against @types/node's webcrypto typings and bridge to
// @peculiar/x509's own WebCrypto types with localized casts.
x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
type CreateSelfSignedParams = Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[0];
/** Chrome caps `serverCertificateHashes` certs at 14 days; stay just under. */
const VALIDITY_DAYS = 13;
/** Regenerate this long before expiry so a running server never serves a dead cert. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

export interface WtCert {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the DER cert, base64 — handed to the browser as serverCertificateHashes. */
  hashBase64: string;
  /** SHA-256 of the DER cert, raw bytes. */
  hash: Uint8Array;
}

function pemBlock(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function generate(): Promise<{ certPem: string; keyPem: string }> {
  const keys = (await webcrypto.subtle.generateKey(ALG as Parameters<typeof webcrypto.subtle.generateKey>[0], true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=speedcrcpy",
    notBefore: new Date(now - 60 * 60 * 1000),
    notAfter: new Date(now + VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    signingAlgorithm: ALG,
    keys: keys as unknown as CreateSelfSignedParams["keys"],
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
      ]),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { certPem: cert.toString("pem"), keyPem: pemBlock("PRIVATE KEY", pkcs8) };
}

function hashOf(certPem: string): { hash: Uint8Array; hashBase64: string; validTo: number } {
  const parsed = new X509Certificate(certPem);
  const hash = new Uint8Array(createHash("sha256").update(parsed.raw).digest());
  return { hash, hashBase64: Buffer.from(hash).toString("base64"), validTo: Date.parse(parsed.validTo) };
}

/**
 * Load the persisted WebTransport cert, regenerating when missing or near
 * expiry. Persisted under `<dataDir>/wt/` so the cert hash stays stable across
 * restarts (clients cache it) until it must be rotated.
 */
export async function loadOrCreateWtCert(dataDir: string): Promise<WtCert> {
  const dir = join(dataDir, "wt");
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");

  let certPem: string | undefined;
  let keyPem: string | undefined;
  if (existsSync(certPath) && existsSync(keyPath)) {
    certPem = readFileSync(certPath, "utf8");
    keyPem = readFileSync(keyPath, "utf8");
    try {
      const { validTo } = hashOf(certPem);
      if (validTo - Date.now() < RENEW_BEFORE_MS) certPem = undefined; // stale → regenerate
    } catch {
      certPem = undefined; // unparseable → regenerate
    }
  }

  if (!certPem || !keyPem) {
    ({ certPem, keyPem } = await generate());
    mkdirSync(dir, { recursive: true });
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
  }

  const { hash, hashBase64 } = hashOf(certPem);
  return { certPem, keyPem, hash, hashBase64 };
}
