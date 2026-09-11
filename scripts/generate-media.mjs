#!/usr/bin/env node
/**
 * Generates every image the demo social layer uses, as SVG, locally.
 *
 * Why generate rather than ship binaries or hotlink a photo service:
 *   - no third-party assets, no licensing question, nothing to attribute;
 *   - the app works with no network access at all;
 *   - the repo stays small and diffable.
 *
 * Output: apps/web/public/media/{avatars,posts,reels,stories}
 * Deterministic: the same index always produces the same artwork, so seeded
 * content does not churn between runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../apps/web/public/media');

/** Deterministic PRNG so artwork is stable across runs. */
function rng(seed) {
  let state = seed * 1103515245 + 12345;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const PALETTES = [
  ['#7c3aed', '#ec4899'],
  ['#0ea5e9', '#6366f1'],
  ['#10b981', '#14b8a6'],
  ['#f59e0b', '#ef4444'],
  ['#f43f5e', '#ec4899'],
  ['#06b6d4', '#3b82f6'],
  ['#8b5cf6', '#06b6d4'],
  ['#84cc16', '#22c55e'],
  ['#e11d48', '#f97316'],
  ['#4f46e5', '#a855f7'],
  ['#0891b2', '#0ea5e9'],
  ['#db2777', '#9333ea'],
];

const svg = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">${body}</svg>`;

const gradient = (id, from, to, angle = 45) => {
  const rad = (angle * Math.PI) / 180;
  const x2 = (Math.cos(rad) * 100).toFixed(1);
  const y2 = (Math.sin(rad) * 100).toFixed(1);
  return `<linearGradient id="${id}" x1="0%" y1="0%" x2="${x2}%" y2="${y2}%">
      <stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>
    </linearGradient>`;
};

/** Monogram avatar: gradient disc with the person's initials. */
function avatar(index, initials) {
  const [from, to] = PALETTES[index % PALETTES.length];
  const size = 256;
  return svg(
    size,
    size,
    `<defs>${gradient(`a${index}`, from, to, 60)}</defs>
     <rect width="${size}" height="${size}" rx="${size / 2}" fill="url(#a${index})"/>
     <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
       font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
       font-size="104" font-weight="600" fill="rgba(255,255,255,0.94)"
       letter-spacing="-2">${initials}</text>`,
  );
}

/**
 * Abstract post artwork: layered translucent shapes over a gradient. Varies
 * enough between seeds that a grid of them does not look repetitive.
 */
function artwork(index, width, height) {
  const [from, to] = PALETTES[index % PALETTES.length];
  const random = rng(index + 1);
  const id = `g${index}`;
  let shapes = '';

  const kind = index % 4;
  for (let i = 0; i < 7; i += 1) {
    const opacity = (0.06 + random() * 0.16).toFixed(3);
    const fill = i % 2 === 0 ? '#ffffff' : '#000000';
    if (kind === 0) {
      const cx = random() * width;
      const cy = random() * height;
      const r = (0.12 + random() * 0.32) * Math.min(width, height);
      shapes += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${fill}" opacity="${opacity}"/>`;
    } else if (kind === 1) {
      const x = random() * width;
      const y = random() * height;
      const w = (0.2 + random() * 0.5) * width;
      const h = (0.05 + random() * 0.2) * height;
      const rot = (random() * 60 - 30).toFixed(1);
      shapes += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="${(h / 2).toFixed(0)}" fill="${fill}" opacity="${opacity}" transform="rotate(${rot} ${x.toFixed(0)} ${y.toFixed(0)})"/>`;
    } else if (kind === 2) {
      const cx = random() * width;
      const cy = random() * height;
      const r = (0.15 + random() * 0.35) * Math.min(width, height);
      shapes += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" stroke="${fill}" stroke-width="${(2 + random() * 10).toFixed(1)}" opacity="${opacity}"/>`;
    } else {
      const x1 = random() * width;
      const y1 = random() * height;
      const x2 = random() * width;
      const y2 = random() * height;
      const x3 = random() * width;
      const y3 = random() * height;
      shapes += `<path d="M${x1.toFixed(0)} ${y1.toFixed(0)} L${x2.toFixed(0)} ${y2.toFixed(0)} L${x3.toFixed(0)} ${y3.toFixed(0)} Z" fill="${fill}" opacity="${opacity}"/>`;
    }
  }

  return svg(
    width,
    height,
    `<defs>${gradient(id, from, to, 20 + (index % 7) * 25)}
      <clipPath id="c${index}"><rect width="${width}" height="${height}"/></clipPath></defs>
     <rect width="${width}" height="${height}" fill="url(#${id})"/>
     <g clip-path="url(#c${index})">${shapes}</g>`,
  );
}

function write(folder, name, contents) {
  const dir = resolve(OUT, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), contents, 'utf8');
}

export const SEED_INITIALS = [
  'AR', 'MK', 'JD', 'SP', 'LN', 'TQ',
  'BW', 'CE', 'DV', 'FH', 'GA', 'RM',
];

let count = 0;

SEED_INITIALS.forEach((initials, i) => {
  write('avatars', `${String(i + 1).padStart(2, '0')}.svg`, avatar(i, initials));
  count += 1;
});

for (let i = 1; i <= 18; i += 1) {
  write('posts', `${String(i).padStart(2, '0')}.svg`, artwork(i, 1080, 1080));
  count += 1;
}

for (let i = 1; i <= 8; i += 1) {
  write('reels', `${String(i).padStart(2, '0')}.svg`, artwork(i + 40, 1080, 1920));
  count += 1;
}

for (let i = 1; i <= 8; i += 1) {
  write('stories', `${String(i).padStart(2, '0')}.svg`, artwork(i + 70, 720, 1280));
  count += 1;
}

// A neutral placeholder for users who have not set an avatar.
write(
  'avatars',
  'placeholder.svg',
  svg(
    256,
    256,
    `<defs>${gradient('ph', '#94a3b8', '#475569', 60)}</defs>
     <rect width="256" height="256" rx="128" fill="url(#ph)"/>
     <circle cx="128" cy="102" r="42" fill="rgba(255,255,255,0.9)"/>
     <path d="M40 232c0-48 39-80 88-80s88 32 88 80z" fill="rgba(255,255,255,0.9)"/>`,
  ),
);
count += 1;

console.log(`[generate-media] wrote ${count} SVG assets to ${OUT}`);
