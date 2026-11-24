/* UnieAI Code — intro film.
 * Every frame is a pure function of t (seconds). The page is driven by
 * renderFrame(t) from a headless browser; nothing is animated by CSS.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- geometry
  const W = 118;          // columns
  const ROWS = 24;        // terminal rows
  const TX_TOP = 3;       // first row of the transcript viewport
  const TX_ROWS = 18;     // rows inside the transcript viewport
  const ROW_H = 1.5;      // row height, em
  const PAD_X = 1.6;      // slab horizontal padding, em
  const PAD_Y = 1.2;      // slab vertical padding, em
  const CHAR_W = 0.60205; // DejaVu Sans Mono advance, em
  const BASE = 15;        // base font size, px (mag 1)
  const DOF = false;      // client asked for no depth-of-field blur
  const NT = DOF ? 3 : 1; // depth-of-field tiers: sharp, near, far
  const MASK_STOPS = 26;
  const FOV_H = 540;      // half frame height, px

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, p) => a + (b - a) * p;
  const easeOut = (p) => 1 - Math.pow(1 - p, 1.65);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

  // ---------------------------------------------------------------- timeline
  // The demo is deliberately a hard bug: a 1-in-200 double charge that only
  // shows up under retry concurrency, spread across three files.
  const PROMPT = 'find the 1-in-200 double-charge in checkout and fix it';
  const T_TYPE0 = 3.25, CPS = 14.6, T_SEND = 6.98, T_WORK_END = 36.15;
  // approval overlay: rises, the cursor moves down one row, Enter accepts
  const T_APP0 = 28.15, T_APPSEL = 29.30, T_APPOK = 29.90, T_APP1 = 30.35;
  // slash-command menu: `/mo` typed, cursor browses, Enter picks /model
  const T_SL0 = 37.25, T_SLTYPE = 37.45, T_SLDOWN = 38.90, T_SLUP = 39.70;
  const T_SLOK = 40.45, T_SL1 = 40.85;
  // the closing wide shot drifts back up through the whole session
  const T_SCROLL0 = 41.70, T_SCROLL1 = 44.60, SCROLL_ROWS = 13;
  const T_COPY = 46.20, T_TAG = 47.65, T_LOGO = 50.20, T_END = 54.60;
  const T_DISSOLVE0 = 45.50, T_DISSOLVE1 = 46.20;

  // ------------------------------------------------------------ transcript
  // [time, duration, segments[[cls, text]], id?]
  const LINES = [];
  const ln = (at, dur, segs, id) => LINES.push({ at, dur, segs, id });
  const blank = (at) => LINES.push({ at, dur: 0.01, segs: [] });

  const diff = (at, dur, num, sign, text) => {
    const segs = [['lnum', String(num).padStart(5, ' ') + ' ']];
    if (sign === '+') segs.push(['add', '+ ' + text]);
    else if (sign === '-') segs.push(['del', '- ' + text]);
    else segs.push(['dim', '  ' + text]);
    ln(at, dur, segs);
  };

  ln(T_SEND, 0.05, [['accent', '› '], ['user', PROMPT]], 'user');
  blank(7.12);
  // --- the hunt: read the retry path, the ledger write, the race test
  ln(7.45, 0.20, [['accent', '•'], ['dim', ' '], ['bold', 'Explored']], 'explored');
  ln(7.60, 0.20, [['faint', '  └ '], ['accent', 'Read'],
                  ['dim', ' services/checkout/src/retry.ts']]);
  ln(7.74, 0.20, [['faint', '  └ '], ['accent', 'Read'],
                  ['dim', ' services/ledger/src/write.ts']]);
  ln(7.88, 0.20, [['faint', '  └ '], ['accent', 'Read'],
                  ['dim', ' src/checkout/race.test.ts']]);
  ln(8.02, 0.20, [['faint', '  └ '], ['accent', 'Search'],
                  ['dim', ' "idempotency_key" in src services']]);
  blank(8.14);
  ln(8.45, 0.20, [['accent', '•'], ['dim', ' '], ['bold', 'Ran'],
                  ['cmd', ' rg -n "idempotency_key|charge_id" src services']], 'rg');
  ln(8.70, 0.20, [['faint', '  └ '], ['dim', 'services/checkout/src/retry.ts:22:'],
                  ['code', ' post("/charge", body)']]);
  ln(9.04, 0.18, [['faint', '    '], ['dim', 'services/checkout/src/retry.ts:29:'],
                  ['code', ' return retry(req);   // 409']]);
  ln(9.38, 0.18, [['faint', '    '], ['dim', 'services/ledger/src/write.ts:38:'],
                  ['code', ' const found = await findByKey(key)']]);
  ln(9.72, 0.18, [['faint', '    '], ['dim', 'services/ledger/src/write.ts:44:'],
                  ['code', ' await insert(row);']]);
  ln(10.06, 0.18, [['faint', '    '], ['dim', 'services/ledger/schema.sql:9:'],
                   ['code', ' -- no UNIQUE on (idempotency_key)']]);
  ln(10.40, 0.18, [['faint', '    '], ['dim', 'src/checkout/race.test.ts:12:'],
                   ['code', ' await Promise.all([pay(), pay()])']]);
  ln(10.72, 0.18, [['faint', '    '], ['dim', '+2 lines (⌃t to view transcript)']]);
  blank(11.40);
  // --- the evidence: duplicate rows in the ledger, 3 ms apart
  ln(11.85, 0.20, [['accent', '•'], ['dim', ' '], ['bold', 'Ran'],
                   ['cmd', ' psql "$LEDGER_DB" -f q/dup_charges.sql']], 'psql');
  ln(12.15, 0.18, [['faint', '  └ '], ['dim', ' charge_id    | count | first_seen']]);
  ln(12.38, 0.16, [['faint', '    '], ['code', '   ch_9f2c41   |     2 | 04:12:07.881']]);
  ln(12.58, 0.16, [['faint', '    '], ['code', '   ch_9f2c08   |     2 | 04:12:07.884']]);
  ln(12.78, 0.16, [['faint', '    '], ['code', '   ch_9f1bd4   |     2 | 04:11:58.902']]);
  ln(12.96, 0.18, [['faint', '  └ '], ['dim', ' (3 rows)']]);
  blank(14.60);
  // --- two sub-agents, running at the same time
  ln(15.90, 0.22, [['accent', '•'], ['dim', ' '], ['bold', 'Spawned'],
                   ['accent', ' Hypatia '], ['dim', '[explorer] '],
                   ['faint', '(DeepSeek-V4-Flash-Vision-Exp high)']], 'spawn1');
  ln(16.14, 0.20, [['faint', '  └ '],
                   ['dim', 'replay the retry storm; name the write that lands twice']]);
  ln(16.55, 0.22, [['accent', '•'], ['dim', ' '], ['bold', 'Spawned'],
                   ['accent', ' Kepler '], ['dim', '[worker] '],
                   ['faint', '(DeepSeek-V4-Flash-Vision-Exp medium)']], 'spawn2');
  ln(16.79, 0.20, [['faint', '  └ '],
                   ['dim', 'write the failing test for the double charge; no fix yet']]);
  ln(17.30, 0.20, [['accent', '•'], ['dim', ' '], ['bold', 'Waiting for 2 agents']], 'wait');
  ln(17.52, 0.18, [['faint', '  └ '], ['dim', 'Hypatia [explorer]']]);
  ln(17.70, 0.18, [['faint', '    '], ['dim', 'Kepler [worker]']]);
  // --- their reports land: the mechanism, named
  ln(20.80, 0.22, [['accent', '•'], ['dim', ' '], ['bold', 'Finished waiting']], 'waited');
  ln(21.02, 0.22, [['faint', '  └ '], ['dim', 'Hypatia [explorer]: '], ['green', 'Completed'],
                   ['faint', ' - '], ['dim', 'retry posts again with no key,']]);
  ln(21.24, 0.20, [['faint', '    '], ['dim', 'key, and the ledger inserts after it looks up']]);
  ln(21.55, 0.22, [['faint', '  └ '], ['dim', 'Kepler [worker]: '], ['green', 'Completed'],
                   ['faint', ' - '], ['dim', '2 of 200 runs write two rows']]);
  ln(21.77, 0.20, [['faint', '    '], ['dim', 'for one request id']]);
  blank(21.95);
  // --- reproduce it before touching the code: red first
  ln(22.55, 0.20, [['accent', '•'], ['dim', ' '], ['bold', 'Ran'],
                   ['cmd', ' pnpm vitest run checkout/race --repeat 200']], 'red');
  ln(22.80, 0.18, [['faint', '  └ '], ['dim', '> billing-api@1.4.0 test']]);
  ln(23.00, 0.18, [['faint', '    '], ['dim', '> vitest run checkout/race --repeat 200']]);
  ln(23.35, 0.18, [['faint', '    '], ['green', '✓'],
                   ['code', ' checkout/race.test.ts > retry creates one charge'],
                   ['dim', ' 199']]);
  ln(23.62, 0.18, [['faint', '    '], ['del', '×'],
                   ['code', ' checkout/race.test.ts > retry creates one charge'],
                   ['dim', ' 1']]);
  ln(23.86, 0.18, [['faint', '    '], ['dim', 'Tests  '], ['bold', '1 failed | 199 passed (200)']],
     'tests');
  ln(24.02, 0.18, [['faint', '  └ '], ['dim', 'charge_id ch_9f2c41 written twice, 3 ms apart']]);
  // --- the fix: one key, one insert
  ln(24.65, 0.22, [['accent', '•'], ['dim', ' '], ['bold', 'Edited'],
                   ['dim', ' 2 files '], ['add', '(+18 '], ['del', '-3)']], 'edited');
  ln(24.85, 0.18, [['faint', '  └ '], ['cmd', 'src/checkout/retry.ts '],
                   ['add', '(+7 '], ['del', '-1)']]);
  diff(25.05, 0.10, 21, ' ', 'const body = await chargeBody(order, attempt);');
  diff(25.25, 0.10, 22, '-', 'const r = await post("/charge", body);');
  diff(25.45, 0.10, 22, '+', 'const r = await post("/charge", body, {');
  diff(25.65, 0.10, 23, '+', '  headers: { "Idempotency-Key": intentKey(order.id) },');
  diff(25.85, 0.10, 24, '+', '});');
  diff(26.05, 0.10, 25, ' ', 'if (r.status === 409) return retry(req);');
  ln(26.35, 0.18, [['faint', '  └ '], ['cmd', 'services/ledger/src/write.ts '],
                   ['add', '(+4 '], ['del', '-2)']]);
  diff(26.55, 0.10, 38, ' ', 'const found = await findByKey(key);');
  diff(26.75, 0.10, 44, '-', 'await insert(row);  // no unique index');
  diff(26.95, 0.10, 44, '+', 'const [ins] = await insertUnique(row);  // one per key');
  diff(27.15, 0.10, 45, '+', 'if (!ins) return found ?? row;');
  diff(27.35, 0.10, 46, ' ', 'return created(row);');
  // --- the full suite, behind one approval
  ln(30.45, 0.20, [['accent', '•'], ['dim', ' '], ['bold', 'Ran'],
                   ['cmd', ' pnpm test -- checkout --repeat 200']], 'ran');
  ln(30.70, 0.18, [['faint', '  └ '], ['dim', '> billing-api@1.4.0 test']]);
  ln(30.92, 0.18, [['faint', '    '], ['dim', '> vitest run checkout --repeat 200']]);
  blank(31.12);
  ln(31.40, 0.18, [['faint', '    '], ['green', '✓'],
                   ['code', ' src/checkout/race.test.ts '], ['dim', '(200 runs) 6.41s']]);
  blank(31.60);
  ln(31.85, 0.18, [['faint', '    '], ['dim', '     Tests  '],
                   ['bold', '200 passed (200)']], 'green');
  blank(32.05);
  LINES.push({ at: 33.00, dur: 1.50, type: true, id: 'ans1',
               text: '• Both attempts now send one idempotency key, and the ledger' });
  LINES.push({ at: 34.70, dur: 1.20, type: true,
               text: '  keeps the first insert — 200 of 200 replays charge once.' });
  let IDX = {};
  LINES.forEach((l, i) => { if (l.id) IDX[l.id] = i; });

  // ---------------------------------------------------------------- shots
  // fr/fc = focal row / column in UI space. tx/ty = screen-space offsets at
  // the start and end of the shot (px).
  const SHOTS = [
    // the product alone in the void: its own header, before anything happens
    { t0: 0.00, t1: 3.20, mag: [3.45, 3.57], pitch: 34, roll: [-11.5, -8.6], yaw: 8,
      fr: 0.8, fc: 10, tx: [-26, -80], ty: [10, 34], blur: 18, sharp: 0.16 },
    // the ask: one line, typed. low and close on the composer
    { t0: 3.20, t1: 7.00, mag: [3.30, 3.42], pitch: 31, roll: [9.0, 12.4], yaw: -6,
      fr: 21.8, fc: 31, tx: [26, 64], ty: [-12, -30], blur: 20, sharp: 0.12 },
    // the hunt: reads, then one rg that shows three suspects at once
    { t0: 7.00, t1: 12.00, mag: [2.85, 2.96], pitch: 30, roll: [-11.0, -8.4], yaw: 9,
      fr: 15.0, fc: 35, tx: [-20, -46], ty: [24, 62], blur: 16, sharp: 0.14 },
    // the evidence, very close: the same charge_id twice, three ms apart
    { t0: 12.00, t1: 15.60, mag: [3.55, 3.70], pitch: 44, roll: [14.4, 11.2], yaw: -7,
      fr: 18.2, fc: 26, tx: [18, 52], ty: [-10, -34], blur: 24, sharp: 0.17 },
    // two sub-agents spawned side by side, then the wait
    { t0: 15.60, t1: 20.40, mag: [2.80, 2.90], pitch: 26, roll: [-9.0, -12.4], yaw: 8,
      fr: 17.0, fc: 31, tx: [-22, -58], ty: [16, 52], blur: 14, sharp: 0.17 },
    // their reports: the mechanism, named by someone else
    { t0: 20.40, t1: 24.20, mag: [2.80, 2.90], pitch: 41, roll: [9.6, 6.0], yaw: -5,
      fr: 16.5, fc: 33, tx: [22, 56], ty: [14, 42], blur: 19, sharp: 0.15 },
    // the fix: the diff streams in under the cursor
    { t0: 24.20, t1: 28.00, mag: [2.95, 3.08], pitch: 33, roll: [-13.0, -9.6], yaw: 8,
      fr: 15.2, fc: 29, tx: [-22, -60], ty: [14, 42], blur: 18, sharp: 0.15 },
    // the approval overlay: the frame drops low and looks up at the question
    { t0: 28.00, t1: 32.60, mag: [2.42, 2.54], pitch: 32, roll: [9.6, 6.0], yaw: -5,
      fr: 18.4, fc: 63, tx: [-4, -40], ty: [-14, -36], blur: 18, sharp: 0.16 },
    // then the whole frame settles and turns almost square-on: the answer, read
    { t0: 32.60, t1: 37.00, mag: [2.80, 2.92], pitch: 24, roll: [6.8, 3.0], yaw: -4,
      fr: 19.6, fc: 32, tx: [10, -22], ty: [8, 24], blur: 15, sharp: 0.15 },
    // the slash menu: steep, from the side, the list running out of frame
    { t0: 37.00, t1: 41.40, mag: [2.45, 2.58], pitch: 32, roll: [-12.8, -9.2], yaw: 9,
      fr: 17.6, fc: 56, tx: [-22, -58], ty: [14, 42], blur: 19, sharp: 0.16 },
    // the only wide shot: height-limited, so the whole window clears the frame
    // while the session scrolls back up through itself
    { t0: 41.40, t1: 46.20, mag: [1.50, 1.60], pitch: 8, roll: [0, 0], yaw: 1.0,
      fr: 12.0, fc: 59, tx: [-6, -30], ty: [10, 22], blur: 4, sharp: 0.82 },
  ];

  function shotAt(t) {
    for (const s of SHOTS) if (t >= s.t0 && t < s.t1) return s;
    return t < SHOTS[0].t0 ? SHOTS[0] : SHOTS[SHOTS.length - 1];
  }

  // ------------------------------------------------------------- render bits
  function rvSpan(cls, text, p, seed) {
    if (p <= 0) return '';
    const c = cls ? ' ' + cls : '';
    if (p >= 1) return '<span class="' + cls + '">' + esc(text) + '</span>';
    const h = hash(seed + text);
    const ms = (0.95 + h * 0.55).toFixed(2);
    const mp = (h * 9.7 % 1).toFixed(2) + 'px ' + (h * 5.3 % 1).toFixed(2) + 'px';
    return '<span class="rv' + c + '" data-s="' + esc(text) + '" style="--p:' + p.toFixed(3) +
           ';--ms:' + ms + 'px;--mp:' + mp + '"><span class="t">' + esc(text) + '</span></span>';
  }

  function segHtml(segs, p, seed) {
    let out = '';
    for (let i = 0; i < segs.length; i++) out += rvSpan(segs[i][0], segs[i][1], p, seed + i);
    return out;
  }

  function txState(t) {
    let html = '', total = 0, newest = 1;
    for (const l of LINES) {
      if (l.at > t) break;
      total++;
      const p = clamp((t - l.at) / l.dur, 0, 1);
      newest = p;
      if (l.type) {
        const n = Math.round(clamp(p * 1.06, 0, 1) * l.text.length);
        const s = l.text;
        const bullet = s.startsWith('• ') && n > 0;
        const body = bullet ? s.slice(2, Math.max(2, n)) : s.slice(0, n);
        html += '<div class="row">' +
                (bullet ? '<span class="accent">•</span> ' : '') +
                '<span class="ans">' + esc(body) + '</span></div>';
      } else {
        html += '<div class="row">' + segHtml(l.segs, p, 'l' + total) + '</div>';
      }
    }
    return { html, total, newest };
  }

  function headerHtml() {
    return '<div class="row"><span class="hdr-mark">  &gt;_ </span>' +
           '<span class="hdr-name">UnieAI Code</span><span class="dim"> (v0.0.37)</span></div>' +
           '<div class="row"><span class="hdr-path">     ~/code/billing-api</span></div>' +
           '<div class="row"></div>';
  }

  const MODEL = 'DeepSeek-V4-Flash-Vision-Exp';
  const CWD = '~/code/billing-api';
  const SEP = ' · ';

  function statusLine(t) {
    const left = '  ' + MODEL + ' default' + SEP + CWD;
    const right = (t >= T_SEND ? 95 : 96) + '% context left';
    return { left, right, pad: Math.max(1, W - left.length - right.length) };
  }

  function botHtml(t, reveal) {
    const worked = t > T_SEND && t < T_WORK_END;
    const secs = Math.max(0, Math.floor(t - T_SEND - 0.02));
    let row22 = '';
    if (worked) {
      row22 = '<span class="accent">•</span><span class="bold"> Working</span>' +
              '<span class="faint"> (' + secs + 's • esc to interrupt)</span>';
    } else {
      const typing = t >= T_TYPE0 && t < T_SEND;
      if (typing) {
        const typed = PROMPT.slice(0, Math.floor((t - T_TYPE0) * CPS));
        const blink = Math.floor(t * 1.9) % 2 === 0;
        row22 = '<span class="accent">›</span> <span class="user">' + esc(typed) + '</span>' +
                (typed.length < PROMPT.length || blink ? '<span class="caret"></span>' : '');
      } else if (t >= T_SL0 && t < T_SLOK) {
        // the slash menu is open: only the two characters typed so far show
        const typed = '/mo'.slice(0, Math.max(0, Math.floor((t - T_SLTYPE) * 9)));
        const blink = Math.floor(t * 1.9) % 2 === 0;
        row22 = '<span class="accent">›</span> <span class="user">' + esc(typed) + '</span>' +
                (typed.length < 3 || blink ? '<span class="caret"></span>' : '');
      } else if (t >= T_SLOK && t < T_SL1) {
        row22 = '<span class="accent">›</span> <span class="user">/model</span>';
      } else if (reveal !== undefined) {
        row22 = rvSpan('accent', '›', clamp(reveal / 0.18, 0, 1), 'c0') +
                rvSpan('dim', ' Ask UnieAI Code to do anything', clamp(reveal / 0.62, 0, 1), 'c1');
      } else {
        row22 = '<span class="accent">›</span><span class="dim"> Ask UnieAI Code to do anything</span>';
      }
    }
    const s = statusLine(t);
    const p4 = reveal === undefined ? 1 : clamp((reveal - 0.30) / 0.44, 0, 1);
    const p5 = reveal === undefined ? 1 : clamp((reveal - 0.46) / 0.40, 0, 1);
    const p6 = reveal === undefined ? 1 : clamp((reveal - 0.58) / 0.38, 0, 1);
    const p7 = reveal === undefined ? 1 : clamp((reveal - 0.74) / 0.26, 0, 1);
    const f = rvSpan('pad2', '  ', 1, 's0') +
              rvSpan('user', MODEL, p4, 's1') +
              rvSpan('dim', ' default', p5, 's2') +
              rvSpan('faint', SEP, p5, 's3') +
              rvSpan('dim', CWD, p6, 's4') +
              ' '.repeat(s.pad) +
              rvSpan('faint', s.right, p7, 's5');
    return '<div class="row"></div><div class="row">' + row22 + '</div>' +
           '<div class="row">' + f + '</div>';
  }

  // ---------------------------------------------------------------- popups
  // Two overlays ride above the composer, both built from strings that exist in
  // codex-rs/tui/src: the exec approval overlay (approval_overlay.rs) and the
  // slash-command menu (slash_command.rs + list_selection_view.rs).
  const APPROVE_CMD = 'pnpm test -- checkout --repeat 200';
  const APPROVE_ROWS = [
    'Yes, proceed',
    "Yes, and don't ask again for this command in this session",
    'No, and tell UnieAI Code what to do differently',
  ];
  const SLASH_ROWS = [
    ['/model', 'choose what model and reasoning effort to use'],
    ['/presets', 'run or save reusable prompts and slash commands'],
    ['/permissions', 'choose what UnieAI Code is allowed to do'],
    ['/plan', 'switch to Plan mode'],
    ['/review', 'review my current changes and find issues'],
    ['/compact', 'summarize conversation to prevent hitting the context limit'],
  ];

  // in/out envelope for an overlay: fade + a small rise from the composer
  function popEnv(t, t0, t1) {
    if (t < t0 || t >= t1) return null;
    const pin = clamp((t - t0) / 0.30, 0, 1);
    const pout = clamp((t1 - t) / 0.26, 0, 1);
    const p = Math.min(pin, pout);
    return { op: Math.pow(p, 0.62).toFixed(3), dy: ((1 - easeOut(pin)) * 0.55).toFixed(3) };
  }

  function approvalHtml(env) {
    let sel = 0;
    if (env.t >= T_APPSEL && env.t < T_APPOK) sel = 1;
    let h = '<div class="ov" style="opacity:' + env.op + ';transform:translateY(' +
            env.dy + 'em)">';
    h += '<div class="ovt">Would you like to run the following command?</div>';
    h += '<div class="ovc"><span class="faint">$ </span><span class="cmd">' +
         esc(APPROVE_CMD) + '</span></div>';
    for (let i = 0; i < APPROVE_ROWS.length; i++) {
      const on = i === sel;
      h += '<div class="ovi' + (on ? ' sel' : '') + '">' +
           '<span class="cur">' + (on ? '›' : ' ') + '</span> ' +
           '<span class="' + (on ? 'bold' : 'dim') + '">' + esc(APPROVE_ROWS[i]) +
           '</span></div>';
    }
    return h + '</div>';
  }

  function slashHtml(env) {
    let sel = 0;
    if (env.t >= T_SLDOWN && env.t < T_SLUP) sel = 1;
    let h = '<div class="mn" style="opacity:' + env.op + ';transform:translateY(' +
            env.dy + 'em)">';
    for (let i = 0; i < SLASH_ROWS.length; i++) {
      const on = i === sel;
      h += '<div class="mni' + (on ? ' sel' : '') + '">' +
           '<span class="mnc ' + (on ? 'bold' : 'cmd') + '">' + esc(SLASH_ROWS[i][0]) +
           '</span><span class="mnd">' + esc(SLASH_ROWS[i][1]) + '</span></div>';
    }
    return h + '</div>';
  }

  function popHtml(t) {
    let env = popEnv(t, T_APP0, T_APP1);
    if (env) { env.t = t; return approvalHtml(env); }
    env = popEnv(t, T_SL0, T_SL1);
    if (env) { env.t = t; return slashHtml(env); }
    return '';
  }

  // ------------------------------------------------------------------ Film
  class Film {
    constructor(stage) {
      this.stage = stage;
      this.stack = stage.querySelector('#stack');
      this.camera = stage.querySelector('#camera');
      this.outro = stage.querySelector('#outro');
      this.copyEl = stage.querySelector('#copy');
      this.nameEl = stage.querySelector('.name');
      this.tagEl = stage.querySelector('.tag');
      this.instEl = stage.querySelector('#install');
      this.logoEl = stage.querySelector('#logo');

      this.copies = [];
      for (let i = 0; i < NT; i++) {
        const plane = document.createElement('div');
        plane.className = 'plane';
        // Per-copy crop window. Every tier paints the same full slab, but only
        // the part that can land on screen is worth rastering: without this the
        // blurred layers are rastered several thousand pixels wide and the blur
        // dominates the render cost.
        const win = document.createElement('div');
        win.className = 'win';
        const slab = document.createElement('div');
        slab.className = 'slab';
        slab.innerHTML = '<div class="zone top"></div>' +
                         '<div class="view"><div class="tx"></div></div>' +
                         '<div class="zone bot"></div>' +
                         '<div class="pop"></div>' +
                         '<div class="pool"></div>';
        win.appendChild(slab);
        plane.appendChild(win);
        this.stack.appendChild(plane);
        this.copies.push({
          plane, slab, win,
          tx: slab.querySelector('.tx'),
          bot: slab.querySelector('.zone.bot'),
          pop: slab.querySelector('.pop'),
          pool: slab.querySelector('.pool'),
          topHtml: null, txHtml: null, botHtml: null, popHtml: null, fontSize: 0,
          winKey: '',
          mask: null,
        });
      }
      this.topHtml = headerHtml();
      this.copies.forEach((c) => { c.slab.querySelector('.zone.top').innerHTML = this.topHtml; });
    }

    render(t) {
      const ui = txState(t);
      const shot = shotAt(t);
      const span = shot.t1 - shot.t0;
      const p = clamp((t - shot.t0) / span, 0, 1);
      const e = easeOut(p);

      const mag = lerp(shot.mag[0], shot.mag[1], e);
      const magBase = shot.mag[0];
      const resid = mag / magBase;
      const roll = lerp(shot.roll[0], shot.roll[1], e);
      const tx = lerp(shot.tx[0], shot.tx[1], e);
      const ty = lerp(shot.ty[0], shot.ty[1], e);
      const fontPx = BASE * magBase;

      // focal point in UI px
      const fx = (PAD_X + shot.fc * CHAR_W) * fontPx;
      const fy = (PAD_Y + (shot.fr + 0.5) * ROW_H) * fontPx;

      const slabH = (PAD_Y * 2 + ROWS * ROW_H) * fontPx;
      const slabW = (PAD_X * 2 + W * CHAR_W) * fontPx;
      const halfView = FOV_H / Math.cos((shot.pitch * Math.PI) / 180);

      // Each tier is built in its own coordinate space: tier k>0 lays the UI out
      // at 1/S scale and multiplies the plane's scale by S, so the projected
      // geometry is identical while its raster is 9x smaller. A blur that large
      // hides the resampling; the sharp tier keeps full resolution.
      const tf = (S) => 'translate3d(' + (960 - fx / S + tx).toFixed(2) + 'px,' +
                        (540 - fy / S + ty).toFixed(2) + 'px,0) rotateX(' + shot.pitch +
                        'deg) rotateY(' + shot.yaw + 'deg) rotateZ(' + roll.toFixed(3) +
                        'deg) scale(' + (resid * S).toFixed(5) + ')';
      const og = (S) => (fx / S).toFixed(1) + 'px ' + (fy / S).toFixed(1) + 'px';

      // transcript scroll: bottom-anchored, newest line lands at the last row
      const base = Math.max(0, ui.total - TX_ROWS);
      let scroll = base > 0 ? base - (1 - ui.newest) : 0;
      // the closing wide shot drifts back up through the whole session
      if (t > T_SCROLL0) {
        const q = clamp((t - T_SCROLL0) / (T_SCROLL1 - T_SCROLL0), 0, 1);
        scroll -= SCROLL_ROWS * (q * q * (3 - 2 * q));
      }
      if (scroll < 0) scroll = 0;
      const scrollPx = scroll * ROW_H * fontPx;

      const reveal = clamp((t - 0.35) / 1.45, 0, 1);
      const fadeIn = clamp(t / 0.62, 0, 1);
      const bot = botHtml(t, reveal < 1 ? reveal : undefined);
      const pop = popHtml(t);
      // pool geometry in em, so it follows each copy's own font size
      const poolR = (700 * magBase / mag) / fontPx;
      const pxv = (fx / fontPx).toFixed(3) + 'em ';
      const pyv = (fy / fontPx).toFixed(3) + 'em';

      // dissolve out to black at the end of the last shot
      let camFilter = 'none', camOpacity = 1;
      if (t > T_DISSOLVE0) {
        const d = clamp((t - T_DISSOLVE0) / (T_DISSOLVE1 - T_DISSOLVE0), 0, 1);
        camOpacity = 1 - d * d;
      }
      const camVisible = t < T_DISSOLVE1 + 0.01;

      this.camera.style.visibility = camVisible ? 'visible' : 'hidden';
      this.camera.style.filter = camFilter;
      this.camera.style.opacity = camOpacity.toFixed(3);

      for (let i = 0; i < NT; i++) {
        const c = this.copies[i];
        const S = 1;
        const fs = fontPx / S;
        c.plane.style.transform = tf(S);
        c.plane.style.transformOrigin = og(S);
        if (c.fontSize !== fs) { c.slab.style.fontSize = fs + 'px'; c.fontSize = fs; }

        // crop the copy to what the viewport can actually show (plus a margin)
        const winW = Math.min(slabW, 3400 / Math.max(resid, 0.05));
        const winH = Math.min(slabH, 2300 / Math.max(resid, 0.05));
        const x0 = clamp(fx - winW / 2, 0, slabW - winW);
        const y0 = clamp(fy - winH / 2, 0, slabH - winH);
        const winKey = x0.toFixed(1) + '/' + y0.toFixed(1) + '/' + winW.toFixed(1);
        if (c.winKey !== winKey) {
          c.win.style.left = x0.toFixed(1) + 'px';
          c.win.style.top = y0.toFixed(1) + 'px';
          c.win.style.width = winW.toFixed(1) + 'px';
          c.win.style.height = winH.toFixed(1) + 'px';
          c.slab.style.marginLeft = (-x0).toFixed(1) + 'px';
          c.slab.style.marginTop = (-y0).toFixed(1) + 'px';
          c.winKey = winKey;
        }
        if (c.txHtml !== ui.html) { c.tx.innerHTML = ui.html; c.txHtml = ui.html; }
        if (c.botHtml !== bot) { c.bot.innerHTML = bot; c.botHtml = bot; }
        if (c.popHtml !== pop) { c.pop.innerHTML = pop; c.popHtml = pop; }
        c.tx.style.transform = 'translateY(' + (-scrollPx / fontPx).toFixed(3) + 'em)';
        c.pool.style.setProperty('--pool-r', poolR.toFixed(3) + 'em');
        c.pool.style.setProperty('--px', pxv);
        c.pool.style.setProperty('--py', pyv);

        // ---- depth of field: tiers of blur, each masked to its distance from the
        // focal row. The masks telescope (sum = 1 at every height), so the layers
        // stack into one continuous falloff.
        const t3 = NT > 1 ? i / (NT - 1) : 0; // 0 = sharp, 1 = far
        const blur = DOF ? (shot.blur * Math.pow(t3, 0.78)) / S : 0;
        const op = 1 - 0.30 * t3;

        const yf = fy / slabH;
        const sharpH = (shot.sharp * halfView) / slabH;   // sharp zone half height
        const gapH = (halfView / slabH) * 0.22;           // ramp between tiers
        const edge = (k) => (k <= 0 ? -1 : sharpH + (k - 1) * gapH);
        const feather = Math.max(0.004, gapH * 0.30);
        const stp = (d, e) => {
          const u = clamp((d - e + feather) / (2 * feather), 0, 1);
          return u * u * (3 - 2 * u);
        };
        const stops = [];
        for (let s = 0; s < MASK_STOPS; s++) {
          const y = s / (MASK_STOPS - 1);
          const d = Math.abs(y - yf);
          // tier i = [edge(i), edge(i+1)) with a crossfade centred on each edge
          const lo = i === 0 ? 1 : stp(d, edge(i));
          const hi = i === NT - 1 ? 0 : stp(d, edge(i + 1));
          stops.push('rgba(0,0,0,' + (lo * (1 - hi)).toFixed(4) + ') ' +
                     (y * 100).toFixed(2) + '%');
        }
        const mask = DOF ? 'linear-gradient(to bottom, ' + stops.join(', ') + ')' : 'none';
        if (c.mask !== mask) {
          c.slab.style.webkitMaskImage = mask;
          c.slab.style.maskImage = mask;
          c.mask = mask;
        }
        // the blur lives on the crop window, so it only touches the visible crop
        c.win.style.filter = blur > 0.12 ? 'blur(' + blur.toFixed(2) + 'px)' : 'none';
        c.plane.style.opacity = (op * fadeIn).toFixed(3);
      }

      // ---- outro
      if (t >= T_COPY) {
        this.outro.style.visibility = 'visible';
        if (t < T_LOGO) {
          const pn = clamp((t - T_COPY) / 0.95, 0, 1);
          const pt = clamp((t - T_TAG) / 0.85, 0, 1);
          this.copyEl.style.opacity = '1';
          this.nameEl.style.opacity = Math.pow(pn, 0.55).toFixed(3);
          this.tagEl.style.opacity = Math.pow(pt, 0.7).toFixed(3);
          this.instEl.style.opacity = (Math.pow(clamp((t - T_TAG - 0.35) / 0.75, 0, 1), 0.8)).toFixed(3);
          this.logoEl.style.opacity = '0';
        } else {
          // crossfade: the copy fades out under the logo instead of cutting to
          // a black subframe at T_LOGO
          const po = 1 - clamp((t - T_LOGO) / 0.34, 0, 1);
          const pl = clamp((t - (T_LOGO - 0.16)) / 0.78, 0, 1);
          this.copyEl.style.opacity = po.toFixed(3);
          this.instEl.style.opacity = po.toFixed(3);
          this.logoEl.style.opacity = Math.pow(pl, 0.7).toFixed(3);
        }
      } else {
        this.outro.style.visibility = 'hidden';
      }
    }
  }

  window.Film = Film;
  window.__meta = { IDX, LINES, SHOTS, T_END, TX_ROWS, ROWS, W };

  // debug: where does every visible transcript line land at time t?
  window.__rows = function (t) {
    window.__film.render(t);
    const c = window.__film.copies[0];
    const em = parseFloat(c.slab.style.fontSize) * 1.5;
    const m = /translateY\((-?[\d.]+)em\)/.exec(c.tx.style.transform || '');
    const scroll = m ? -parseFloat(m[1]) / 1.5 : 0; // translated em -> rows
    return Array.from(c.tx.children).map((el) => ({
      row: +(TX_TOP + el.offsetTop / em - scroll).toFixed(2),
      text: el.textContent.length > 56 ? el.textContent.slice(0, 56) : el.textContent,
    }));
  };
})();
