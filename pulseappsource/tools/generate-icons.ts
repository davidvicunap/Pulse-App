/**
 * Generates the PWA icon set from a single SVG source.
 *
 * The icon is the app's signature made small: an ECG trace crossing a dark panel, with
 * the R-spike in phosphor. It has to survive being 48px on a home screen, so the trace
 * is heavier and simpler than the one in the app — a faithful miniature would turn to
 * mush at that size.
 *
 * Run with `npm run icons`. Output lands in `public/icons/` and is committed, so a
 * normal build needs neither sharp nor this script.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const INK = '#070A10';
const PHOSPHOR = '#5EEAD4';
const DIM = '#1E2434';

/**
 * @param inset Fraction of the canvas to keep clear at the edges. Maskable icons get a
 *   generous inset because platforms crop them to arbitrary shapes — a circle mask on a
 *   full-bleed icon would slice the trace off.
 */
function iconSvg(size: number, opts: { rounded: boolean; inset: number }): string {
  const { rounded, inset } = opts;
  const pad = size * inset;
  const w = size - pad * 2;
  const mid = size / 2;

  // A single clean complex: flat baseline, small P, tall R, deep S, rounded T.
  const u = w / 22;
  const x0 = pad;
  const amp = w * 0.3;
  const d = [
    `M ${x0} ${mid}`,
    `H ${x0 + u * 5}`,
    `q ${u * 1.1} ${-amp * 0.2} ${u * 2.2} 0`,
    `L ${x0 + u * 8.4} ${mid + amp * 0.22}`,
    `L ${x0 + u * 9.8} ${mid - amp}`,
    `L ${x0 + u * 11.2} ${mid + amp * 0.52}`,
    `L ${x0 + u * 12.6} ${mid}`,
    `q ${u * 1.6} ${-amp * 0.34} ${u * 3.2} 0`,
    `H ${x0 + w}`,
  ].join(' ');

  const radius = rounded ? size * 0.22 : 0;
  const stroke = size * 0.055;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#111726"/>
      <stop offset="1" stop-color="${INK}"/>
    </linearGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${size * 0.018}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  <path d="M ${pad} ${mid} H ${size - pad}" stroke="${DIM}" stroke-width="${stroke * 0.5}" stroke-linecap="round"/>
  <path d="${d}" fill="none" stroke="${PHOSPHOR}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
</svg>`;
}

async function main(): Promise<void> {
  const outDir = resolve(process.cwd(), 'public/icons');
  mkdirSync(outDir, { recursive: true });

  // The scalable icon browsers prefer when they support SVG.
  writeFileSync(resolve(outDir, 'icon.svg'), iconSvg(512, { rounded: true, inset: 0.18 }));

  const targets: Array<{ file: string; size: number; rounded: boolean; inset: number }> = [
    { file: 'icon-192.png', size: 192, rounded: true, inset: 0.18 },
    { file: 'icon-512.png', size: 512, rounded: true, inset: 0.18 },
    // Maskable: no corner radius (the platform applies its own) and a wide safe zone.
    { file: 'maskable-512.png', size: 512, rounded: false, inset: 0.28 },
    // iOS ignores the manifest and uses this, and it must be fully opaque and square.
    { file: 'apple-touch-icon.png', size: 180, rounded: false, inset: 0.18 },
  ];

  for (const target of targets) {
    const svg = iconSvg(target.size, { rounded: target.rounded, inset: target.inset });
    await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      .flatten({ background: INK })
      .toFile(resolve(outDir, target.file));
    console.log(`wrote icons/${target.file} (${target.size}px)`);
  }

  // The splash screen iOS shows while a standalone launch boots.
  const splash = `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532" viewBox="0 0 1170 2532">
  <rect width="1170" height="2532" fill="${INK}"/>
  <g transform="translate(405 1086)">${iconSvg(360, { rounded: true, inset: 0.18 })
    .replace(/<\/?svg[^>]*>/g, '')}</g>
  <text x="585" y="1560" text-anchor="middle" fill="${PHOSPHOR}"
        font-family="ui-monospace, monospace" font-size="34" letter-spacing="12">PULSE</text>
</svg>`;
  await sharp(Buffer.from(splash)).png({ compressionLevel: 9 }).toFile(resolve(outDir, 'splash-1170x2532.png'));
  console.log('wrote icons/splash-1170x2532.png');
}

void main();
