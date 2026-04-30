#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const [,, inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error('Usage: node tools/pos-to-json.js <input.pos> [output.json]');
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const basename = path.basename(inputPath, '.pos');
const outputPath = outputArg
  ? path.resolve(outputArg)
  : path.resolve(__dirname, '..', 'layouts', `${basename}.json`);

const raw = fs.readFileSync(inputPath, 'utf8');

const leds = [];

for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  // skip blank lines and comment/header lines
  if (!trimmed || trimmed.startsWith('#')) continue;

  const cols = trimmed.split(/\s+/);
  // Ref Val Package PosX PosY Rot Side — need at least 6 cols
  if (cols.length < 6) continue;

  const [ref,, , posX, posY] = cols;
  // only LED components: D followed by one or more digits
  if (!/^D\d+$/.test(ref)) continue;

  const num = parseInt(ref.slice(1), 10);
  leds.push({ num, x: parseFloat(posX), y: -parseFloat(posY) });
}

if (leds.length === 0) {
  console.error('No LED components (D*) found in pos file.');
  process.exit(1);
}

leds.sort((a, b) => a.num - b.num);

const keys = leds.map(({ x, y }) => [x, y]);

const layout = {
  name: basename,
  keys,
};

const outDir = path.dirname(outputPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(outputPath, JSON.stringify(layout, null, 2) + '\n');

console.log(`Written ${keys.length} keys → ${outputPath}`);
