#!/usr/bin/env node
/**
 * Bundles the AudioWorklet.
 *
 * `audioWorklet.addModule()` loads a classic script in every browser, but ES
 * module `import` inside a worklet is only reliably supported in recent Chromium
 * and is still absent or buggy elsewhere. A failed import there is *silent*:
 * `registerProcessor` never runs, the node fails to construct, and the fallback
 * path would send the caller's untransformed voice down the wire. That is the
 * one failure mode this feature must not have, so instead of importing we
 * concatenate the DSP core and the processor into a single classic script and
 * strip the module syntax.
 *
 * Source of truth stays src/voice/dsp-core.js — the same file the test suite
 * imports — so the tested code and the shipped code cannot diverge.
 *
 *   src/voice/dsp-core.js + src/voice/worklet-processor.js
 *     -> public/worklets/voice-processor.js
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = resolve(repoRoot, 'apps/web');

const CORE = resolve(webRoot, 'src/voice/dsp-core.js');
const PROCESSOR = resolve(webRoot, 'src/voice/worklet-processor.js');
const OUT_DIR = resolve(webRoot, 'public/worklets');
const OUT = resolve(OUT_DIR, 'voice-processor.js');

/** Removes ESM syntax so the result is a valid classic script. */
function stripModuleSyntax(source, label) {
  const withoutImports = source.replace(
    /^\s*import\s+[^;]*?;\s*$/gm,
    (match) => `// [build-worklet] removed import from ${label}: ${match.trim()}`,
  );
  // `export class X` -> `class X`, `export function f` -> `function f`, etc.
  return withoutImports
    .replace(/^\s*export\s+(?=(class|function|const|let|var)\s)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '');
}

const core = stripModuleSyntax(readFileSync(CORE, 'utf8'), 'dsp-core.js');
const processor = stripModuleSyntax(
  readFileSync(PROCESSOR, 'utf8'),
  'worklet-processor.js',
);

const banner = `/* !!! GENERATED FILE - DO NOT EDIT !!!
 *
 * Built by scripts/build-worklet.mjs from:
 *   apps/web/src/voice/dsp-core.js         (the DSP, also covered by dsp-core.test.ts)
 *   apps/web/src/voice/worklet-processor.js (the AudioWorkletProcessor shell)
 *
 * Edit those, then run:  npm run build:worklet
 * It is rebuilt automatically by "npm run dev" and "npm run build".
 */
`;

if (!/registerProcessor\(\s*['"]sonder-voice-processor['"]/.test(processor)) {
  console.error(
    '[build-worklet] worklet-processor.js does not register "sonder-voice-processor". Aborting.',
  );
  process.exit(1);
}
const bundle = `${banner}\n${core}\n\n${processor}\n`;

/**
 * Verify the result really is a valid *classic* script. Compiling it with the
 * VM module is a far better check than grepping for `import`/`export`, which
 * cannot tell syntax from the same words inside a comment — and a worklet that
 * fails to parse fails silently in the browser.
 */
try {
  new Script(bundle, { filename: 'voice-processor.js' });
} catch (error) {
  console.error(`[build-worklet] bundle is not a valid classic script: ${error.message}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, bundle, 'utf8');

const bytes = Buffer.byteLength(readFileSync(OUT));
console.log(
  `[build-worklet] wrote public/worklets/voice-processor.js (${(bytes / 1024).toFixed(1)} kB)`,
);
