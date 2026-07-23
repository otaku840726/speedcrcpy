/**
 * Binary WebSocket frame format.
 *
 * Every ws message is binary; the first byte selects the channel.
 * Video frames are split into chunks (<= VIDEO_CHUNK_SIZE payload bytes) so the
 * send queue can interleave control/audio messages between chunks of a large
 * frame — this bounds priority inversion on a single TCP connection.
 */
export const Channel = {
  JSON: 0x00,
  VIDEO_META: 0x11,
  VIDEO_CONF: 0x12,
  VIDEO_CHUNK: 0x13,
  AUDIO_META: 0x21,
  AUDIO_DATA: 0x23,
} as const;
export type ChannelId = (typeof Channel)[keyof typeof Channel];

export const VIDEO_CHUNK_SIZE = 16 * 1024;

/** VIDEO_CHUNK header layout after the channel byte. */
// u32 frameId | u16 chunkIndex | u16 chunkCount | u8 flags | u64 pts | payload
export const VIDEO_CHUNK_HEADER_SIZE = 1 + 4 + 2 + 2 + 1 + 8;

export const VideoFlags = {
  KEYFRAME: 0x01,
} as const;

export interface VideoChunk {
  frameId: number;
  chunkIndex: number;
  chunkCount: number;
  keyframe: boolean;
  /** microseconds, from scrcpy */
  pts: bigint;
  payload: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeJsonFrame(message: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = Channel.JSON;
  frame.set(body, 1);
  return frame;
}

export function encodeMetaFrame(channel: ChannelId, meta: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(meta));
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = channel;
  frame.set(body, 1);
  return frame;
}

export function encodeVideoConfFrame(config: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + config.byteLength);
  frame[0] = Channel.VIDEO_CONF;
  frame.set(config, 1);
  return frame;
}

export function encodeVideoChunkFrame(chunk: VideoChunk): Uint8Array {
  const frame = new Uint8Array(VIDEO_CHUNK_HEADER_SIZE + chunk.payload.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = Channel.VIDEO_CHUNK;
  view.setUint32(1, chunk.frameId);
  view.setUint16(5, chunk.chunkIndex);
  view.setUint16(7, chunk.chunkCount);
  view.setUint8(9, chunk.keyframe ? VideoFlags.KEYFRAME : 0);
  view.setBigUint64(10, chunk.pts);
  frame.set(chunk.payload, VIDEO_CHUNK_HEADER_SIZE);
  return frame;
}

export function encodeAudioDataFrame(pts: bigint, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 8 + payload.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = Channel.AUDIO_DATA;
  view.setBigUint64(1, pts);
  frame.set(payload, 9);
  return frame;
}

export type DecodedFrame =
  | { channel: typeof Channel.JSON; message: unknown }
  | { channel: typeof Channel.VIDEO_META; meta: unknown }
  | { channel: typeof Channel.AUDIO_META; meta: unknown }
  | { channel: typeof Channel.VIDEO_CONF; config: Uint8Array }
  | { channel: typeof Channel.VIDEO_CHUNK; chunk: VideoChunk }
  | { channel: typeof Channel.AUDIO_DATA; pts: bigint; payload: Uint8Array };

export function decodeFrame(data: Uint8Array): DecodedFrame {
  const channel = data[0];
  switch (channel) {
    case Channel.JSON:
      return { channel, message: JSON.parse(textDecoder.decode(data.subarray(1))) };
    case Channel.VIDEO_META:
    case Channel.AUDIO_META:
      return { channel, meta: JSON.parse(textDecoder.decode(data.subarray(1))) };
    case Channel.VIDEO_CONF:
      return { channel, config: data.subarray(1) };
    case Channel.VIDEO_CHUNK: {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        channel,
        chunk: {
          frameId: view.getUint32(1),
          chunkIndex: view.getUint16(5),
          chunkCount: view.getUint16(7),
          keyframe: (view.getUint8(9) & VideoFlags.KEYFRAME) !== 0,
          pts: view.getBigUint64(10),
          payload: data.subarray(VIDEO_CHUNK_HEADER_SIZE),
        },
      };
    }
    case Channel.AUDIO_DATA: {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return { channel, pts: view.getBigUint64(1), payload: data.subarray(9) };
    }
    default:
      throw new Error(`Unknown channel byte: ${channel}`);
  }
}

/** Split an encoded video frame into chunk frames ready to enqueue. */
export function chunkVideoFrame(
  frameId: number,
  keyframe: boolean,
  pts: bigint,
  data: Uint8Array,
): Uint8Array[] {
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / VIDEO_CHUNK_SIZE));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const payload = data.subarray(i * VIDEO_CHUNK_SIZE, Math.min((i + 1) * VIDEO_CHUNK_SIZE, data.byteLength));
    frames.push(encodeVideoChunkFrame({ frameId, chunkIndex: i, chunkCount, keyframe, pts, payload }));
  }
  return frames;
}
