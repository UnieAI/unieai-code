import puppeteer from 'puppeteer';
import path from 'node:path';
const HERE = '/home/ubuntu/service/unieai-code/film/unieai-studio-tokenfactory';
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files'] });
const p = await b.newPage();
await p.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await p.goto('file://' + path.join(HERE, 'index.html'), { waitUntil: 'load' });
await p.evaluateHandle('document.fonts.ready');
await p.waitForFunction('window.__ready === true');
p.on('console', m => { const t = m.text(); if (t.includes('ERR')) console.log(t); });
await p.evaluate(() => window.renderFrame(13.6));
const out = await p.evaluate(() => {
  const g = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); const s = document.querySelector('.slab').getBoundingClientRect(); return { top: Math.round(r.top - s.top), bot: Math.round(r.bottom - s.top), left: Math.round(r.left - s.left), h: Math.round(r.height) }; };
  return { slab: (() => { const r = document.querySelector('.slab').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    stream: g('.stream'), two: g('.two'), pmain: g('.pmain'),
    cands: ['.prail','.pmain','.stream','.chathead','.comp','.composer','.cin','#page','.page'].map(s => [s, g(s)]) };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
