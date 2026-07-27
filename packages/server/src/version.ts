/**
 * Build identity, baked in at image build time (see Dockerfile / CI).
 * `SPEEDCRCPY_VERSION` is the git commit SHA the image was built from — the
 * marker used to tell which build a running (production) instance is on.
 * Falls back to "dev" for local/unbuilt runs.
 */
export const VERSION = process.env.SPEEDCRCPY_VERSION || "dev";
export const BUILT_AT = process.env.SPEEDCRCPY_BUILT_AT || "";
