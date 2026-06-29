// Node file wrapper. Pure core: parse-otlp.js (gunzips here; core takes raw bytes)
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOtlpBytes } from '../src/parse-otlp.js';
import type { Profile } from '../src/model.ts';
export function parseOtlp(path: string): Profile {
  const raw = readFileSync(path);
  const data = (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw;
  return parseOtlpBytes(data) as Profile;
}
