/**
 * WebTransport wire framing (Phase 1).
 *
 * Unlike WebSocket, a WebTransport stream is a raw byte pipe with no message
 * boundaries, so the control and audio streams carry **length-prefixed**
 * frames. The inner bytes reuse the existing channel-prefixed encoding
 * (`encodeJsonFrame` / `encodeMetaFrame` / …) so both sides can keep using
 * `decodeFrame`. Video takes a different shape: **one unidirectional stream
 * per frame**, so the stream itself is the boundary — no length prefix, the
 * reader just consumes to EOF.
 */

/** First byte of every server→client unidirectional stream, selecting its kind. */
export const WtStreamType = {
  AUDIO: 0x01,
  VIDEO: 0x02,
} as const;
export type WtStreamTypeId = (typeof WtStreamType)[keyof typeof WtStreamType];

/** VIDEO uni-stream header (after the stream-type byte): flags | pts | frameId. */
// u8 flags | u64 pts | u32 frameId | payload…
const WT_VIDEO_HEADER_SIZE = 1 + 8 + 4;

const VideoFlags = { KEYFRAME: 0x01 } as const;

/** Prefix a frame with its u32 big-endian length for a length-delimited stream. */
export function encodeStreamFrame(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + frame.byteLength);
  new DataView(out.buffer).setUint32(0, frame.byteLength);
  out.set(frame, 4);
  return out;
}

/**
 * Incremental parser for a length-delimited stream: feed arbitrary byte chunks,
 * get back whichever complete inner frames are now available. Handles frames
 * split across chunks and multiple frames per chunk.
 */
export class StreamFrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    // Append.
    const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.byteLength);
    this.buf = merged;

    const frames: Uint8Array[] = [];
    let offset = 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    while (this.buf.byteLength - offset >= 4) {
      const len = view.getUint32(offset);
      if (this.buf.byteLength - offset - 4 < len) break; // frame not fully arrived
      frames.push(this.buf.slice(offset + 4, offset + 4 + len));
      offset += 4 + len;
    }
    if (offset > 0) this.buf = this.buf.slice(offset);
    return frames;
  }
}

/** Encode one video frame for its dedicated uni stream: type byte + header + data. */
export function encodeWtVideoStream(
  frameId: number,
  keyframe: boolean,
  pts: bigint,
  data: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(1 + WT_VIDEO_HEADER_SIZE + data.byteLength);
  const view = new DataView(out.buffer);
  out[0] = WtStreamType.VIDEO;
  view.setUint8(1, keyframe ? VideoFlags.KEYFRAME : 0);
  view.setBigUint64(2, pts);
  view.setUint32(10, frameId);
  out.set(data, 1 + WT_VIDEO_HEADER_SIZE);
  return out;
}

export interface WtVideoFrame {
  frameId: number;
  keyframe: boolean;
  pts: bigint;
  data: Uint8Array;
}

/** Decode a fully-read VIDEO uni stream body (the bytes AFTER the type byte). */
export function decodeWtVideoBody(body: Uint8Array): WtVideoFrame {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    keyframe: (view.getUint8(0) & VideoFlags.KEYFRAME) !== 0,
    pts: view.getBigUint64(1),
    frameId: view.getUint32(9),
    data: body.subarray(WT_VIDEO_HEADER_SIZE),
  };
}
