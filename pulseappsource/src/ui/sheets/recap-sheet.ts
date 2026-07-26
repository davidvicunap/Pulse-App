/**
 * The weekly recap sheet, plus the shareable snapshot.
 *
 * The snapshot is rendered to a canvas entirely on-device and handed to the Web Share
 * API (or a download, where sharing isn't available). Nothing is uploaded to produce it
 * — which is the point: a share feature that round-tripped health data through a server
 * would quietly undo the app's central promise.
 */

import type { WeeklyRecap } from '../../insights/recap';
import { getState } from '../../core/store';
import { formatDayLabel } from '../../core/dates';
import { signed } from '../../core/format';
import { h, render, token } from '../dom';
import { openSheet } from '../sheet';
import { ecgPath, planBeats } from '../ecg';
import { haptic } from '../../core/haptics';

export function openRecapSheet(recap: WeeklyRecap): void {
  openSheet(
    {
      title: 'Weekly recap',
      eyebrow: `${formatDayLabel(recap.startDate)} – ${formatDayLabel(recap.endDate)}`,
    },
    (body) => {
      render(
        body,
        h('p', { class: 'recap-lead' }, recap.headline),

        h('div', { class: 'recap-grid' },
          ...recap.metrics.map((m) =>
            h('div', { class: 'recap-tile' },
              h('div', { class: 'recap-tile-label' }, m.label),
              h('div', { class: 'recap-tile-value' }, m.value == null ? '—' : m.format(m.value)),
              m.changePct == null
                ? h('div', { class: 'recap-tile-delta' }, 'no prior week')
                : h('div', {
                    class: `recap-tile-delta ${m.favourable ? 'is-good' : m.favourable === false ? 'is-bad' : ''}`,
                  }, `${signed(m.changePct, 0, '%')} vs last week`),
            ),
          ),
        ),

        recap.notes.length
          ? h('div', null,
              h('h3', { class: 'sheet-section' }, 'Worth noting'),
              h('ul', { class: 'recap-notes' }, ...recap.notes.map((n) => h('li', null, n))))
          : null,

        h('div', { class: 'sheet-actions' },
          h('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: (e: Event) => shareSnapshot(recap, e.currentTarget as HTMLButtonElement),
          }, 'Save a snapshot'),
        ),
        h('p', { class: 'sheet-foot' },
          'The snapshot is drawn on this device and never uploaded. It contains only the ' +
          'summary numbers shown above.'),
      );
    },
  );
}

// ─────────────────────────── snapshot ───────────────────────────

const W = 1080;
const H = 1350; // 4:5, the aspect that survives most feeds uncropped

/**
 * Draws the recap to a canvas.
 * Uses the app's own design tokens so the exported image is unmistakably the same
 * product rather than a generic card.
 */
export function drawSnapshot(canvas: HTMLCanvasElement, recap: WeeklyRecap): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = W;
  canvas.height = H;

  const ink = token('--ink') || '#070A10';
  const graphite = token('--graphite') || '#0D111A';
  const bone = token('--bone') || '#ECEFF6';
  const ash = token('--ash') || '#8B93A9';
  const phosphor = token('--phosphor') || '#5EEAD4';
  const mono = token('--mono') || 'monospace';
  const sans = token('--sans') || 'sans-serif';

  // Background with a soft radial lift, mirroring the hero card.
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 200, 40, W / 2, 200, 900);
  glow.addColorStop(0, 'rgba(94,234,212,0.10)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // The signature ECG trace across the top.
  const recovery = recap.metrics.find((m) => m.key === 'recovery');
  const beats = planBeats({
    restingHr: 60,
    hrv: 55,
    recovery: recovery?.value ?? 60,
  }, 5);
  ctx.save();
  ctx.translate(0, 150);
  ctx.strokeStyle = phosphor;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = phosphor;
  ctx.shadowBlur = 24;
  ctx.stroke(new Path2D(ecgPath(beats, W, 120)));
  ctx.restore();

  // Wordmark
  ctx.fillStyle = phosphor;
  ctx.font = `700 30px ${mono}`;
  ctx.letterSpacing = '10px';
  ctx.fillText('PULSE', 80, 100);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = ash;
  ctx.font = `500 30px ${mono}`;
  ctx.fillText(
    `${formatDayLabel(recap.startDate).toUpperCase()} – ${formatDayLabel(recap.endDate).toUpperCase()}`,
    80, 380,
  );

  // Layout flows from here rather than using fixed offsets, so a one-line headline
  // doesn't leave a hole above the tiles and a three-line one doesn't collide with them.
  ctx.fillStyle = bone;
  ctx.font = `600 52px ${sans}`;
  const headlineLines = wrapText(ctx, recap.headline, 80, 460, W - 160, 66);
  let y = 460 + headlineLines * 66 + 70;

  // Metric tiles, two per row.
  const tiles = recap.metrics.filter((m) => m.value != null).slice(0, 4);
  const tileW = (W - 160 - 30) / 2;
  const tileH = 190;
  tiles.forEach((metric, i) => {
    const col = i % 2;
    const rowIndex = Math.floor(i / 2);
    const x = 80 + col * (tileW + 30);
    const ty = y + rowIndex * (tileH + 26);

    ctx.fillStyle = graphite;
    roundRect(ctx, x, ty, tileW, tileH, 28);
    ctx.fill();
    ctx.strokeStyle = token('--hairline') || '#1E2434';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = ash;
    ctx.font = `500 24px ${mono}`;
    ctx.fillText(metric.label.toUpperCase(), x + 32, ty + 56);

    ctx.fillStyle = bone;
    ctx.font = `800 62px ${mono}`;
    ctx.fillText(metric.format(metric.value!), x + 32, ty + 130);

    if (metric.changePct != null) {
      // Some metrics have no good direction — strain is neither better up nor down —
      // so a null verdict renders neutral rather than being coloured as a problem.
      ctx.fillStyle =
        metric.favourable == null
          ? ash
          : metric.favourable
            ? token('--vital') || '#34D399'
            : token('--alert') || '#F87171';
      ctx.font = `500 26px ${mono}`;
      ctx.fillText(`${signed(metric.changePct, 0, '%')}`, x + 32, ty + 168);
    }
  });
  y += Math.ceil(tiles.length / 2) * (tileH + 26);

  const footerY = H - 70;
  // A note is drawn only when it fits *whole*. A caption cut off mid-sentence reads as
  // a broken image, so the first note that fits wins and the rest are dropped.
  if (recap.notes.length) {
    const noteY = y + 56;
    const lineHeight = 44;
    const room = Math.floor((footerY - 44 - noteY) / lineHeight);
    ctx.font = `400 30px ${sans}`;
    const note = recap.notes.find((n) => room >= 1 && measureLines(ctx, n, W - 160) <= room);
    if (note) {
      ctx.fillStyle = ash;
      wrapText(ctx, note, 80, noteY, W - 160, lineHeight, room);
    }
  }

  ctx.fillStyle = token('--iron') || '#6B738C';
  ctx.font = `500 22px ${mono}`;
  ctx.fillText('GENERATED ON DEVICE · NOTHING UPLOADED', 80, footerY);
}

async function shareSnapshot(recap: WeeklyRecap, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Drawing…';

  try {
    const canvas = document.createElement('canvas');
    drawSnapshot(canvas, recap);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The image could not be created.');

    const file = new File([blob], `pulse-week-${recap.startDate}.png`, { type: 'image/png' });

    // Prefer the native share sheet, but only when it will actually accept the file.
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: 'Pulse — weekly recap' });
      haptic('success');
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      haptic('success');
    }
  } catch (err) {
    // A user cancelling the share sheet throws AbortError — that isn't a failure.
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      button.textContent = 'Could not save';
      setTimeout(() => (button.textContent = original), 2200);
      button.disabled = false;
      return;
    }
  }
  button.textContent = original;
  button.disabled = false;
  void getState();
}

/** How many lines `text` would need at the current font, without drawing anything. */
function measureLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): number {
  let line = '';
  let lines = 1;
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines++;
      line = word;
    } else {
      line = test;
    }
  }
  return lines;
}

/** Draws wrapped text and returns how many lines it used, so callers can flow below it. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 4,
): number {
  const words = text.split(' ');
  let line = '';
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines++;
      if (lines >= maxLines) return lines;
      line = word;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) {
    ctx.fillText(line, x, y + lines * lineHeight);
    lines++;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
