// Render frames of the UnieAI Code intro film with headless Chrome.
//   node render.mjs stills 0.4,1.6,3.1        -> stills/t_<t>.png  (960x540)
//   node render.mjs preview                   -> preview.mp4 (960x540, 30fps)
//   node render.mjs master                    -> master.mp4  (1920x1080, 60fps)
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const mode = process.argv[2] || 'stills';
const arg = process.argv[3] || '';

const CFG = {
  rows: { w: 960, h: 540, fps: 0 },
  stills: { w: 960, h: 540, fps: 0 },
  preview: { w: 960, h: 540, fps: 30, sub: 2, crf: 20, preset: 'medium' },
  master: { w: 1920, h: 1080, fps: 60, sub: 4, crf: 17, preset: 'slow' },
}[mode];
if (!CFG) { console.error('unknown mode', mode); process.exit(1); }

const DUR = 52.8;
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none',
         '--disable-lcd-text', '--force-color-profile=srgb',
         '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(HERE, 'index.html') + (process.env.FLAT ? '?flat=1' : ''), { waitUntil: 'load' });
await page.evaluateHandle('document.fonts.ready');
await page.waitForFunction('window.__ready === true');

const metrics = await page.evaluate(() => {
  const s = document.querySelector('.slab').getBoundingClientRect();
  return { w: s.width, h: s.height };
});
console.log('slab at mag1:', metrics);

const t0 = Date.now();
let n = 0;

// Chrome sometimes hands back an unpainted compositor frame (nine masked, blurred
// DOF layers get re-rastered whenever the content changes), so let frames commit
// and re-shoot while the PNG is still a flat black rectangle.
const settle = () =>
  page.evaluate(() => new Promise((r) => {
    let i = 0;
    const step = () => (++i >= 4 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }));
const drawAt = async (t) => {
  await page.evaluate((tt) => window.renderFrame(tt), t);
  await settle();
};

// Reloading wipes every compositor layer and re-parses in ~40 ms, which is far
// cheaper than shooting frames off a Chrome whose raster budget has run dry.
let stageScale = 1;
let lastSize = 0;
const reset = async () => {
  await page.goto('file://' + path.join(HERE, 'index.html'), { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  if (stageScale !== 1) {
    await page.evaluate((k) => {
      const s = document.getElementById('stage');
      s.style.transform = 'scale(' + k + ')';
      s.style.transformOrigin = '0 0';
    }, stageScale);
  }
  lastSize = 0;
};

// A frame that really painted weighs far more than a flat rectangle. The bar
// has to be per resolution: at 540p the end card (a white mark on black) is a
// legitimate 4.4 KB and at 1080p 12 KB, while a blank frame is ~2.7 KB at both.
// The film opens on black, so the first half second is allowed to be tiny.
const FLAT = CFG.w >= 1500 ? 9000 : 3600;
const suspect = (size, t) => size <= FLAT && t > 0.6;
let bad = 0;
const shootAt = async (t, file) => {
  for (let k = 0; k < 4; k++) {
    if (k > 0) await reset();
    await drawAt(t);
    await page.screenshot({ path: file, type: 'png' });
    const size = fs.statSync(file).size;
    if (!suspect(size, t)) { lastSize = size; return size; }
  }
  bad++;
  console.warn('kept a doubtful frame', file, 'at t=' + t.toFixed(3));
  lastSize = 0;
};

if (mode === 'rows') {
  const times = (arg || '8,11,14,17,20,23,26,30,34,40').split(',').map(Number);
  for (const t of times) {
    const rows = await page.evaluate((tt) => window.__rows(tt), t);
    console.log('--- t=' + t);
    for (const r of rows) console.log(String(r.row).padStart(6), '|', r.text);
  }
} else if (mode === 'stills') {
  const times = arg ? arg.split(',').map(Number) : [0.5, 2.5, 5, 9, 14, 18, 24, 29, 33, 39, 42.5, 46.5];
  for (const t of times) {
    const p = path.join(OUT, 't_' + t.toFixed(2).padStart(5, '0') + '.png');
    await shootAt(t, p);
    console.log(p);
  }
} else {
  const { w, h, fps, sub } = CFG;
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  // our layout is authored at 1920x1080; scale the stage for the preview
  stageScale = w / 1920;
  await reset();

  const frames = Math.round(DUR * fps);
  const outdir = path.join(OUT, 'frames_' + mode);
  fs.mkdirSync(outdir, { recursive: true });
  // `node render.mjs preview 924,1074` re-shoots just that range of frames
  const [from, to] = /^\d+,\d+$/.test(arg) ? arg.split(',').map(Number) : [0, frames];
  for (let i = from; i < Math.min(to, frames); i++) {
    if (i > 0 && i % 120 === 0) await reset();
    for (let s = 0; s < sub; s++) {
      const t = (i + s / sub) / fps;
      await shootAt(t, path.join(outdir, 'f' + String(i).padStart(5, '0') + '_' + s + '.png'));
    }
    n++;
    if (i % 60 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`frame ${i}/${frames}  ${el.toFixed(0)}s  eta ${((Math.min(to, frames) - i) * el / (i - from + 1)).toFixed(0)}s`);
    }
  }
  console.log('captured', Math.min(to, frames) - from, 'frames x', sub);
}

console.log("total", ((Date.now() - t0) / 1000).toFixed(1), "s");
if (bad) console.log("doubtful frames:", bad);
await browser.close();
