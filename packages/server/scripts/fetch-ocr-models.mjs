#!/usr/bin/env node
/**
 * Fetch the PP-OCRv6 models the script engine recognises text with.
 *
 * `@gutenye/ocr-node` bundles PP-OCRv4, whose dictionary (`ppocr_keys_v1.txt`,
 * 6623 chars) is simplified-Chinese only: 遊 戲 戰 獎 勵 閉 認 擇 擊 儲 繼 簽 領
 * 螢 錢 and many other everyday traditional characters are simply not in it, so
 * the model cannot output them however clear the image is — measured on a real
 * screen, 遊戲 came back as 游 and 闖關大挑戰 as 關大挑. PP-OCRv6's dictionary
 * (18708 chars) covers all of them.
 *
 * Same shape as the scrcpy-server fetch: a postinstall step, so the Docker
 * build gets the files for free from `pnpm install` and nothing binary lands in
 * git. Downloads are pinned by SHA-256; a mismatch fails the install rather
 * than silently running an unexpected model.
 *
 * Note the *small* tier specifically: v6-tiny ships a 6904-char dictionary with
 * the same traditional-Chinese holes as v4, so it would defeat the point.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "models");

/** Pinned to the PaddleOCR release that first shipped official ONNX exports. */
const FILES = [
  {
    name: "det.onnx",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx",
    sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
  },
  {
    name: "rec.onnx",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx",
    sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
  },
  {
    name: "dict.txt",
    url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv6_dict.txt",
    sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
  },
];

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** True when the file is already there and intact — the usual case on rebuild. */
function alreadyHave(path, sha256) {
  try {
    return digest(readFileSync(path)) === sha256;
  } catch {
    return false;
  }
}

async function fetchOne({ name, url, sha256 }) {
  const target = join(MODELS_DIR, name);
  if (alreadyHave(target, sha256)) {
    console.log(`ocr-models: ${name} already present`);
    return;
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  const got = digest(buffer);
  if (got !== sha256) throw new Error(`${name}: sha256 mismatch (expected ${sha256}, got ${got})`);

  // Write via a temp name so an interrupted run can't leave a half file that
  // looks valid to the next `alreadyHave` check.
  const temp = `${target}.part`;
  writeFileSync(temp, buffer);
  renameSync(temp, target);
  console.log(`ocr-models: fetched ${name} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

mkdirSync(MODELS_DIR, { recursive: true });
try {
  for (const file of FILES) await fetchOne(file);
} catch (error) {
  // Don't fail the whole install: the engine falls back to the bundled PP-OCRv4
  // and logs that it did, so a developer offline still gets a working server.
  rmSync(join(MODELS_DIR, "rec.onnx.part"), { force: true });
  rmSync(join(MODELS_DIR, "det.onnx.part"), { force: true });
  console.warn(`ocr-models: ${error instanceof Error ? error.message : error}`);
  console.warn("ocr-models: falling back to the bundled PP-OCRv4 (traditional Chinese will be misread)");
}
