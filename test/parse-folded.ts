// Node file wrapper. Pure core: parse-folded.js
import { readFileSync } from 'node:fs';
import { parseFoldedText } from '../src/parse-folded.js';
import type { Profile } from '../src/model.ts';
export function parseFolded(path: string): Profile { return parseFoldedText(readFileSync(path, 'utf8')) as Profile; }
