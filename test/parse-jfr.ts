// Node file wrapper. Pure core: parse-jfr.js
import { readFileSync } from 'node:fs';
import { parseJfrBytes } from '../src/parse-jfr.js';
import type { Profile } from '../src/model.ts';
export function parseJfr(path: string): Profile { return parseJfrBytes(new Uint8Array(readFileSync(path))) as Profile; }
