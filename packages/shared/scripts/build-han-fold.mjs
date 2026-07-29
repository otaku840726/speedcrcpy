#!/usr/bin/env node
/**
 * Regenerate `src/han-fold.ts` from OpenCC's character table.
 *
 * Run by hand when the table needs refreshing — not part of the build, so the
 * package has no network step and no runtime dependency on OpenCC (whose npm
 * package is ~6 MB, almost all of it phrase and regional-idiom data that
 * character-level matching has no use for).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "han-fold.ts");

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`OpenCC table: HTTP ${response.status}`);

const traditional = [];
const simplified = [];
for (const line of (await response.text()).split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [key, values] = line.split("\t");
  // Several traditional characters map to more than one simplified form; the
  // first is OpenCC's preferred one, and any consistent choice folds fine.
  const value = values?.split(" ")[0];
  if (!key || !value || [...key].length !== 1 || [...value].length !== 1 || key === value) continue;
  traditional.push(key);
  simplified.push(value);
}

const header = `/**
 * Traditional → simplified character folding, so text matching doesn't care
 * which form the recogniser happened to emit.
 *
 * PP-OCRv6 can output *either* form for the same glyph depending on the crop
 * it sees: measured on one screen, a full-frame pass read a button as 已安裝
 * while a tighter crop of the same pixels read 已安装. Matching on the literal
 * characters therefore fails unpredictably — including inside the engine's own
 * narrowing pass, which compares a whole line against a crop of itself.
 *
 * Folding both sides to one form fixes that, and as a bonus lets a script
 * author type either form regardless of what the device displays.
 *
 * Character-level only, which is all substring matching needs — no phrase or
 * regional-idiom conversion, so no runtime dependency. Generated from OpenCC's
 * TSCharacters.txt (first candidate per key); regenerate with
 * \`node packages/shared/scripts/build-han-fold.mjs\`.
 */

`;

const body =
  `const TRADITIONAL = ${JSON.stringify(traditional.join(""))};\n\n` +
  `const SIMPLIFIED = ${JSON.stringify(simplified.join(""))};\n`;

const tail = `
// Spread, not index: the table contains characters outside the BMP, and
// indexing by UTF-16 code unit puts every pair after the first one out of step.
const FOLD = new Map<string, string>();
{
  const from = [...TRADITIONAL];
  const to = [...SIMPLIFIED];
  for (let i = 0; i < from.length; i++) FOLD.set(from[i]!, to[i]!);
}

/** Fold a string to one Han variant. Characters with no mapping pass through. */
export function foldHan(text: string): string {
  let out = "";
  for (const ch of text) out += FOLD.get(ch) ?? ch;
  return out;
}
`;

writeFileSync(OUT, header + body + tail);
console.log(`han-fold: ${traditional.length} pairs → ${OUT}`);
