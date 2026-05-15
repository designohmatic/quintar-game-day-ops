#!/usr/bin/env node
/*
 * build-frontend.mjs — bundles the static frontend for S3.
 *
 * Output: ./dist/ containing landing.html, event-view.html, state.js,
 * roster.json, template.json, amplify_outputs.js (placeholder).
 *
 * What changes vs the source files:
 *   - A <script>window.QUINTAR_API_BASE='…'</script> is injected before the
 *     module script in each HTML so state.js points at the prod API.
 *   - amplify_outputs.js is the example template — IT replaces it with the
 *     real rotated AppSync values right before the s3 sync.
 *
 * Env vars:
 *   QUINTAR_API_BASE   default https://playground.quintar.ai
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT  = path.join(ROOT, 'dist');

const API_BASE = process.env.QUINTAR_API_BASE || 'https://playground.quintar.ai';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── Static assets copied verbatim ────────────────────────────────────────────
for (const f of ['state.js', 'roster.json', 'template.json']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}

// ── HTML rewriting ───────────────────────────────────────────────────────────
// Inject window.QUINTAR_API_BASE before the first <script type="module"> so
// state.js sees it when imported. State.js falls back to localhost:3005 when
// the global is unset, so dev workflow is unaffected.
const configTag = `<script>window.QUINTAR_API_BASE=${JSON.stringify(API_BASE)};</script>`;

for (const f of ['landing.html', 'event-view.html']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const marker = '<script type="module">';
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error(`No <script type="module"> in ${f}`);
  const out = src.slice(0, idx) + configTag + '\n' + src.slice(idx);
  fs.writeFileSync(path.join(OUT, f), out);
}

// ── AppSync config placeholder ───────────────────────────────────────────────
// IT replaces this file with one containing the rotated key before s3 sync.
fs.copyFileSync(
  path.join(ROOT, 'amplify_outputs.example.js'),
  path.join(OUT, 'amplify_outputs.js'),
);

// ── Default root object ──────────────────────────────────────────────────────
// CloudFront's default root maps `/` → `landing.html`. Setting it in S3 too is
// belt-and-suspenders for direct-S3 access if needed.
fs.copyFileSync(
  path.join(OUT, 'landing.html'),
  path.join(OUT, 'index.html'),
);

console.log(`Built ${path.relative(ROOT, OUT)}/ — API_BASE=${API_BASE}`);
console.log('');
console.log('NEXT: replace dist/amplify_outputs.js with the real AppSync values');
console.log('      (endpoint, region, apiKey) before running deploy-frontend.sh.');
