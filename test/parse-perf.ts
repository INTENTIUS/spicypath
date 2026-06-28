// Node file wrapper. Pure core: parse-perf.js
import { readFileSync } from 'node:fs';
import { parsePerfScriptText } from '../src/parse-perf.js';
import type { Profile } from '../src/model.ts';
export function parsePerf(path: string): Profile { return parsePerfScriptText(readFileSync(path, 'utf8')) as Profile; }
