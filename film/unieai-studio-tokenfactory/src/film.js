/* UnieAI Studio — Token Factory film.
   Every frame is a pure function of t. No animation CSS, no timeouts,
   no transition: the renderer sets all state from t each frame.        */
(function () {
  'use strict';

  var DUR = 48.0;
  var T_COPY = 38.4;   /* copy line starts, 64 bars in */
  var T_END = 43.2;    /* end card */

  /* ---------------------------------------------------------------- utils */
  function cl(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ss(a, b, x) { var t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function eo(t) { return 1 - Math.pow(1 - cl(t, 0, 1), 3); }
  function n2(x) { return Math.round(x * 100) / 100; }

  /* ---------------------------------------------------------------- icons */
  var P = {
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    key: '<circle cx="7.5" cy="15.5" r="5"/><path d="m21 3-9.5 9.5"/><path d="m15.5 8 3 3 2.5-2.5-3-3"/>',
    bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    sparkle: '<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
    win: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M2.5 9h19"/>',
    globe: '<circle cx="12" cy="12" r="9.3"/><path d="M2.7 12h18.6"/><path d="M12 2.7a14 14 0 0 1 0 18.6 14 14 0 0 1 0-18.6Z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    net: '<rect x="9" y="2.5" width="6" height="6" rx="1.5"/><rect x="2" y="15.5" width="6" height="6" rx="1.5"/><rect x="16" y="15.5" width="6" height="6" rx="1.5"/><path d="M12 8.5V12M5 15.5V12h14v3.5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.3"/><path d="m19.8 19.8-4.4-4.4"/>',
    updown: '<path d="m8 9 4-4 4 4"/><path d="m8 15 4 4 4-4"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9h-5.5"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2.4"/><path d="M9 3v18"/>',
    dots: '<circle cx="12" cy="5.5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="12" cy="18.5" r="1.1"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
    layers: '<path d="m12 3 9 4.8-9 4.8-9-4.8L12 3Z"/><path d="m3 12.6 9 4.8 9-4.8"/><path d="m3 17.2 9 4.8 9-4.8"/>',
    arrow: '<path d="M5 12h13"/><path d="m12.5 5.5 6.5 6.5-6.5 6.5"/>',
    send: '<path d="M12 19V6"/><path d="m5.5 12.5 6.5-6.5 6.5 6.5"/>',
    msg: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.6-3.4A8.5 8.5 0 1 1 21 11.5Z"/>',
    store: '<path d="M3 9.5 5 4h14l2 5.5"/><path d="M3 9.5h18V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5Z"/><path d="M9.5 13.5h5"/>',
    db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    plug: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9Z"/><path d="M12 18v3"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>'
  };
  function ic(name, s, sw) {
    s = s || 15; sw = sw || 1.7;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round">' + P[name] + '</svg>';
  }
  function dotc(c, s) {
    return '<span style="display:inline-block;width:' + (s || 8) + 'px;height:' + (s || 8) +
      'px;border-radius:50%;background:' + c + ';flex:none"></span>';
  }

  var MARK_SM =
    '<svg class="mk" viewBox="0 0 19 19" fill="none">' +
    '<path d="M2.1 11.7 15.4 3.1l1.5 2.6L3.6 14.3z" fill="#12141a"/>' +
    '<rect x="2.6" y="11.4" width="13.6" height="5.4" rx="2.7" fill="#12141a"/>' +
    '</svg>';

  /* ---------------------------------------------------------------- data */
  /* real catalogue rows, verbatim from the live UnieAI Model Zoo */
  var MODELS = [
    { kind: 'Chat', nm: 'Qwen3.6-35B-A3B', pvd: 'openai-compatible',
      tags: ['Reasoning', 'Vision', 'FP16', 'Tool calling'], a: '$0.05', b: '$0.10', act: 'Use base model' },
    { kind: 'Chat', nm: 'gemma-4-31B-it', pvd: 'gemma-4-31B-it',
      tags: ['Reasoning', 'Vision', 'FP16', 'Tool calling'], a: '$0.05', b: '$0.15', act: 'Use base model' },
    { kind: 'Chat', nm: 'DeepSeek-V4-Flash-Vision-Exp', pvd: 'DeepSeek-V4-Flash-Vision-Exp',
      tags: ['Reasoning', 'Vision', 'Long context', 'FP16'], a: '$0.44', b: '$1.32', act: 'Use base model' },
    { kind: 'Chat', nm: 'DeepSeek-V4.1-Flash-1017', pvd: 'DeepSeek-V4.1-Flash-1017',
      tags: ['Reasoning', 'Vision', 'FP16', 'Tool calling'], a: '$0.00', b: '$0.00', act: 'Use base model' },
    { kind: 'Image', nm: 'FLUX.2-dev', pvd: 'FLUX.2-dev',
      tags: ['Reasoning', 'FP16'], a: '$0.00', b: '$0.00', act: 'Use base model' },
    { kind: 'Image', nm: 'Qwen-Image-Edit-2511', pvd: 'Qwen-Image-Edit-2511',
      tags: ['Reasoning', 'FP16'], a: '$0.00', b: '$0.00', act: 'Join waitlist' }
  ];
  var EMB = [
    { kind: 'Embedding', nm: 'Qwen3-Embedding-8B', pvd: 'Qwen3-Embedding-8B',
      tags: ['Embedding', 'FP16'], a: '$0.00', b: '$0.00', act: 'Use base model' },
    { kind: 'Embedding', nm: 'Ebd-512', pvd: 'Ebd-512',
      tags: ['Embedding', 'FP16'], a: '$0.00', b: '$0.00', act: 'Use base model' },
    { kind: 'Embedding', nm: 'Qwen3-New', pvd: 'Qwen3-New',
      tags: ['Embedding', 'FP16'], a: '$0.00', b: '$0.00', act: 'Use base model' }
  ];

  /* ---------------------------------------------------------------- shell */
  function sidebar(active) {
    var h = '<aside class="sb">';
    h += '<div class="logo">' + MARK_SM + '<span class="nm">UnieAI Studio</span></div>';
    h += '<div class="ws">' + ic('shield', 14) + '<span class="lb">Personal Space</span>' +
      '<span class="ch">' + ic('updown', 12, 2) + '</span></div>';
    h += '<div class="srch">' + ic('search', 13) + '<span class="q">Search</span><span class="kbd mono">⌘K</span></div>';
    var top = [
      ['Usage', 'activity', 182], ['API keys', 'key', 220]
    ];
    for (var i = 0; i < top.length; i++) {
      h += '<div class="it' + (top[i][0] === active ? ' on' : '') + '" style="top:' + top[i][2] + 'px">' +
        '<span class="ic">' + ic(top[i][1], 16) + '</span><span class="tx">' + top[i][0] + '</span></div>';
    }
    var items = [
      { g: 'Token Factory', y: 268 },
      { y: 292, t: 'UnieAI Model Zoo', ic: 'layers' },
      { y: 330, t: 'Playground', ic: 'msg' },
      { y: 368, t: 'Fine-tuning', ic: 'sparkle' },
      { y: 406, t: 'Inference endpoints', ic: 'net' },
      { y: 444, t: 'Batch inference', ic: 'grid' },
      { y: 482, t: 'Image Model Toolbox', ic: 'win' },
      { y: 520, t: 'My Models', ic: 'cpu' }
    ];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (it.g) h += '<div class="grp" style="top:' + it.y + 'px">' + it.g + '</div>';
      else h += '<div class="it' + (it.t === active ? ' on' : '') + '" style="top:' + it.y + 'px">' +
        '<span class="ic">' + ic(it.ic, 16) + '</span><span class="tx">' + it.t + '</span></div>';
    }
    h += '<div class="hr" style="top:722px"></div>';
    var foot = [
      ['Documentation', 'book'], ['UnieAI official website', 'globe'], ['Discord', 'msg'],
      ['Admin panel', 'shield'], ['Compute provider', 'net']
    ];
    for (var k = 0; k < foot.length; k++) {
      h += '<div class="it" style="top:' + (748 + k * 38) + 'px">' +
        '<span class="ic">' + ic(foot[k][1], 15) + '</span><span class="tx">' + foot[k][0] + '</span></div>';
    }
    return h + '</aside>';
  }

  function topbar(activeTab) {
    var tabs = ['Home', 'GPU Fabric', 'Token Factory', 'Agent Builder'];
    var h = '<div class="tb"><span class="col">' + ic('panel', 17) + '</span><div class="tabs">';
    for (var i = 0; i < tabs.length; i++) {
      h += '<div class="tab' + (tabs[i] === activeTab ? ' on' : '') + '">' + tabs[i] + '</div>';
    }
    h += '</div><div class="right"><div class="wallet"><span class="mono" style="font-size:12.5px">$0.00</span>' +
      ic('chev', 12, 2) + '</div><div class="av">MI</div></div></div>';
    return h;
  }

  function mcard(m, i) {
    var h = '<div class="mcard" data-id="mc' + i + '"><div class="top"><span class="kind">' + m.kind +
      '</span><span class="pvd mono">' + m.pvd + '</span></div>';
    h += '<div class="nm">' + m.nm + '</div><div class="tags">';
    for (var j = 0; j < m.tags.length; j++) h += '<span class="chip">' + m.tags[j] + '</span>';
    h += '</div><div class="price"><span class="amt mono">' + m.a + '</span>' +
      '<span class="per">/ 1M tokens</span><span class="out mono">out ' + m.b + ' / 1M tokens</span></div>';
    h += '<div class="bar"></div><div class="use" data-id="use' + i + '">' + m.act +
      '<span class="k">' + ic('arrow', 13) + '</span></div></div>';
    return h;
  }

  function pageZoo() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>UnieAI Model Zoo</h1><div class="sub">12 models available</div>' +
      '<div class="acts"><div class="btn ico">' + ic('dots', 15) + '</div>' +
      '<div class="btn"><span data-id="spin" style="display:flex">' + ic('refresh', 14) + '</span>' +
      '<span class="p">Refresh</span></div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Create Agent</span></div></div></div>';

    var f = ['All', 'Personal & group', 'Fusion Models', 'Text', 'Embedding', 'Image', 'Audio', 'Video', 'Other'];
    h += '<div class="fbar">';
    for (var i = 0; i < f.length; i++) h += '<div class="fchip' + (i === 0 ? ' on' : '') + '">' + f[i] + '</div>';
    h += '<div class="sp"></div><div class="sel">Category' + ic('chev', 12, 2) + '</div>' +
      '<div class="sel">Popular' + ic('chev', 12, 2) + '</div></div>';

    h += '<div class="zgrp"><span>Text</span><span class="n">6</span><span class="ln"></span></div><div class="zgrid">';
    for (var t = 0; t < 4; t++) h += mcard(MODELS[t], t);
    h += '</div>';
    h += '<div class="zgrp"><span>Image</span><span class="n">2</span><span class="ln"></span></div><div class="zgrid">';
    for (var im = 4; im < 6; im++) h += mcard(MODELS[im], im);
    h += '</div>';
    h += '<div class="zgrp"><span>Embedding</span><span class="n">3</span><span class="ln"></span></div>' +
      '<div class="zgrid">';
    for (var em = 0; em < EMB.length; em++) h += mcard(EMB[em], 10 + em);
    h += '</div>';
    return h + '</div>';
  }

  /* ---- playground */
  var ANS_A = 'A FIX 4.4 Execution Report carries 35=E; the fill price is tag 31 (LastPx) ' +
    'and the filled quantity is tag 32 (LastQty). Split on SOH first, then read the tags you need — ' +
    'tags 54 and 39 describe the side, not the price, so you can skip them.';
  var ANS_B = 'Ticket 8821 filled 1,200 shares at 148.62 — nothing to escalate.';
  var ANS_C = 'Notional is 1,200 × 148.62 = 178,344.00 USD.';

  function pagePlay() {
    var h = '<div class="prail"><div class="hd"><span>Chats</span>' + ic('plus', 13, 2) + '</div>' +
      '<div class="new">' + ic('plus', 13, 2) + 'New chat</div>' +
      '<div class="citem on">' + ic('msg', 14) + '<span>FIX parser</span></div>' +
      '<div class="citem">' + ic('msg', 14) + '<span>Ticket summariser</span></div>' +
      '<div class="citem">' + ic('msg', 14) + '<span>Schema explain</span></div></div>';

    h += '<div class="pmain"><div class="ph"><span class="m">Qwen3.6-35B-A3B</span>' + ic('chev', 12, 2) +
      '<span class="r"><span class="s on">Chat</span><span class="s">Code</span>' +
      '<span class="s">Model info</span>' + ic('dots', 14) + '</span></div>';

    h += '<div class="stream"><div class="u"><div class="bb">' +
      'Parse the FIX 4.4 execution report below into a dict and tell me the fill price:' +
      '<div class="mono" style="margin-top:8px;font-size:12px;color:#5f656d">' +
      '8=FIX.4.4|35=E|11=8821|31=148.62|32=1200|</div></div></div>';
    h += '<div class="a"><div class="av">' + ic('sparkle', 14) + '</div>' +
      '<div class="col"><div class="tx" data-id="ans"></div>' +
      '<div class="codeblk" data-id="anscode" style="opacity:0">' +
      '<span class="c"># tag 31 = last px, tag 32 = last qty</span>\n' +
      '<span class="k">pairs</span> = dict(p.split(<span class="s">\'=\'</span>, 1) ' +
      '<span class="k">for</span> p <span class="k">in</span> raw.split(<span class="s">\'\\x01\'</span>) ' +
      '<span class="k">if</span> p)\n' +
      '<span class="k">assert</span> pairs[<span class="s">\'35\'</span>] == <span class="s">\'E\'</span>\n' +
      'fill = {<span class="s">\'px\'</span>: float(pairs[<span class="s">\'31\'</span>]), ' +
      '<span class="s">\'qty\'</span>: int(pairs[<span class="s">\'32\'</span>])}\n' +
      '<span class="k">print</span>(f<span class="s">\'{fill["qty"]:,} @ {fill["px"]}\'</span>)</div>' +
      '<div class="tx" data-id="ans2"></div></div></div>' +
      '<div class="u u2" data-id="u2" style="opacity:0"><div class="bb">and the notional?</div></div>' +
      '<div class="a a2" data-id="a2" style="opacity:0"><div class="av">' + ic('sparkle', 14) + '</div>' +
      '<div class="col"><div class="tx" data-id="ans3"></div></div></div></div>';

    h += '<div class="composer"><div class="in"><span class="ph">Ask anything… (Enter to send, Shift+Enter for newline)</span></div>' +
      '<div class="ft"><span>Press Shift + Enter for a new line. Press Enter to send.</span>' +
      '<span class="mono">· T 0.7 · P 1 · K 40 · Max --</span>' +
      '<span class="send">' + ic('send', 15, 2) + '</span></div></div>';
    return h + '</div>';
  }

  /* ---- fine-tuning: create job */
  function pageTune() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>Fine-tuning</h1>' +
      '<div class="sub">A clear view of your fine-tuning jobs</div>' +
      '<div class="acts"><div class="btn"><span data-id="spin2" style="display:flex">' + ic('refresh', 14) + '</span>' +
      '<span class="p">Refresh</span></div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Create fine-tuning job</span></div></div></div>';

    h += '<div class="two"><div class="col">';

    h += '<div class="blk"><div class="lb">Model</div><div class="radios">' +
      '<div class="rd on"><span class="o"></span>From base model<span class="d">Fine-tune a supported base model.</span></div>' +
      '<div class="rd"><span class="o"></span>From previous run<span class="d">Continue training from a completed job.</span></div>' +
      '<div class="rd"><span class="o"></span>From HF Hub<span class="d">Import a model from Hugging Face.</span></div>' +
      '</div><div class="iso" data-id="isoM"><span class="mono">unsloth/Qwen3-8B</span><span class="ch">' +
      ic('chev', 13, 2) + '</span></div></div>';

    h += '<div class="blk"><div class="lb">Datasets</div>' +
      '<div class="hint">JSONL with text or messages rows, at least two examples, up to 20 MB.</div>' +
      '<div style="display:flex;gap:10px"><div class="iso" style="flex:1" data-id="isoD">' +
      '<span class="mono">support-tickets-2026.jsonl</span><span class="ch">' + ic('chev', 13, 2) + '</span></div>' +
      '<div class="iso" style="flex:1"><span class="mut mono">Validation file (optional)</span>' +
      '<span class="ch">' + ic('chev', 13, 2) + '</span></div></div></div>';

    h += '<div class="blk"><div class="lb">Training settings</div>' +
      '<div style="display:flex;gap:10px;margin-top:9px">' +
      '<div class="iso" style="flex:1;margin-top:0"><span class="mut">Name</span>' +
      '<span class="mono" style="margin-left:6px">qwen3-8b-support</span></div>' +
      '<div class="iso" style="width:120px;margin-top:0"><span class="mut">Epochs</span>' +
      '<span class="mono" style="margin-left:auto">3</span></div></div>' +
      '<div style="display:flex;gap:24px;margin-top:13px">' +
      '<div><div class="lb sm">Training type</div><div class="seg" style="margin-top:6px">' +
      '<div class="g on">SFT</div><div class="g">DPO</div><div class="g">GRPO</div></div></div>' +
      '<div><div class="lb sm">Training method</div><div class="seg" style="margin-top:6px">' +
      '<div class="g on">QLoRA</div><div class="g">LoRA</div><div class="g">Full</div></div></div></div>' +
      '<div class="iso"><span class="mono">Shared training pool</span><span class="ch">' + ic('chev', 13, 2) + '</span></div>' +
      '</div>';

    h += '</div><div class="side"><div class="sum"><div class="t">Summary</div>' +
      '<div class="kv"><span class="k">Model</span><span class="v mono" style="font-size:12px">unsloth/Qwen3-8B</span></div>' +
      '<div class="kv"><span class="k">Training file</span><span class="v mono" style="font-size:12px">2,480 rows</span></div>' +
      '<div class="kv"><span class="k">Type</span><span class="v">SFT · QLoRA</span></div>' +
      '<div class="kv"><span class="k">Epochs</span><span class="v">3</span></div>' +
      '<div class="hr"></div>' +
      '<div class="est"><span class="k">Estimated cost</span><span class="v" data-id="cost">$3.40</span></div>' +
      '<div class="go" data-id="go">' + ic('arrow', 14, 2) + 'Queue training</div>' +
      '<div class="hint" style="margin-top:10px;font-size:11.5px;line-height:1.5;color:#a3a8af">' +
      'Shared jobs wait for an eligible runner. Runtime limits include model loading and checkpoint uploads.</div>' +
      '</div></div></div>';
    return h + '</div>';
  }

  /* ---- fine-tuning jobs */
  function pageJobs() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>Fine-tuning</h1>' +
      '<div class="sub">Fine-tuning jobs run on the pool and land in your models when they finish</div>' +
      '<div class="acts"><div class="btn">Visual overview</div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Create fine-tuning job</span></div></div></div>';

    h += '<div class="tbl"><div class="th"><div class="c" style="width:330px">Job</div>' +
      '<div class="c" style="width:290px">Base model</div><div class="c" style="width:150px">Method</div>' +
      '<div class="c" style="width:180px">Status</div><div class="c" style="width:150px">Created</div>' +
      '<div class="c" style="flex:1"></div></div>';

    h += '<div class="tr jrow" style="height:92px"><div class="c" style="width:330px"><div style="flex:1">' +
      '<div class="nm">qwen3-8b-support</div>' +
      '<div class="mut"><span data-id="ep">Epoch 2 / 3</span> · loss <span class="mono" data-id="loss">1.284</span></div>' +
      '<div class="prog"><div class="fl" data-id="fl" style="width:0%"></div></div></div></div>' +
      '<div class="c" style="width:290px"><span class="mdl mono">unsloth/Qwen3-8B</span></div>' +
      '<div class="c" style="width:150px"><span class="mut">SFT · QLoRA</span></div>' +
      '<div class="c" style="width:180px"><span class="chip vio">' +
      '<span data-id="spin3" style="display:flex">' + ic('refresh', 12, 2.2) + '</span>Training</span></div>' +
      '<div class="c" style="width:150px"><span class="mut">12 min ago</span></div>' +
      '<div class="c" style="flex:1;justify-content:flex-end;color:#a3a8af">' + ic('dots', 15) + '</div></div>';

    var rows = [
      ['support-tone-sft', 'unsloth/Qwen3-14B', 'SFT · QLoRA', 'Succeeded', '48 min'],
      ['invoice-extract-dpo', 'unsloth/Llama-3.2-1B-Instruct', 'DPO · LoRA', 'Queued', '1 hr'],
      ['ticket-router-sft', 'unsloth/Qwen3-4B', 'SFT · LoRA', 'Succeeded', '3 hr']
    ];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var grn = r[3] === 'Succeeded';
      h += '<div class="tr"><div class="c" style="width:330px"><span class="nm">' + r[0] + '</span></div>' +
        '<div class="c" style="width:290px"><span class="mdl mono">' + r[1] + '</span></div>' +
        '<div class="c" style="width:150px"><span class="mut">' + r[2] + '</span></div>' +
        '<div class="c" style="width:180px"><span class="chip' + (grn ? ' grn' : '') + '">' +
        dotc(grn ? '#00a97a' : '#c2820b', 6) + r[3] + '</span></div>' +
        '<div class="c" style="width:150px"><span class="mut">' + r[4] + ' ago</span></div>' +
        '<div class="c" style="flex:1;justify-content:flex-end;color:#a3a8af">' + ic('dots', 15) + '</div></div>';
    }
    h += '</div>';
    h += '<div class="foot">4 jobs · 1 running<div class="r"><span>Rows per page 10</span>' +
      '<span>Page 1 of 1</span></div></div>';
    return h + '</div>';
  }

  /* ---- inference endpoint */
  function pageEndpoint() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>Inference endpoints</h1>' +
      '<div class="sub">Deploy fine-tuned or open models as OpenAI-compatible API endpoints, ' +
      'called by their Model Zoo model ID.</div>' +
      '<div class="acts"><div class="btn"><span data-id="spin4" style="display:flex">' + ic('refresh', 14) + '</span>' +
      '<span class="p">Refresh</span></div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Create endpoint</span></div></div></div>';

    h += '<div style="display:flex;gap:18px;margin-top:22px">';
    h += '<div style="width:352px;flex:none"><div class="epcard"><div class="ttl">qwen3-8b-support</div>' +
      '<div style="margin-top:8px"><span class="chip grn">' + dotc('#00a97a', 6) + 'Ready</span></div>' +
      '<div class="row"><span class="k">Model ID</span><span class="v mono" style="font-size:12px">qwen3-8b-support</span></div>' +
      '<div class="row"><span class="k">Base model</span><span class="v mono" style="font-size:12px">unsloth/Qwen3-8B</span></div>' +
      '<div class="row"><span class="k">Pool</span><span class="v">Shared pool</span></div>' +
      '<div class="row"><span class="k">Rate limit</span><span class="v">40 req / min</span></div>' +
      '<div class="row"><span class="k">Auth</span><span class="v">API key</span></div>' +
      '</div></div>';

    h += '<div style="flex:1;min-width:0"><div class="code"><div class="cb">' + ic('cpu', 13) +
      '<span class="t">Python · openai</span><span class="cp">Copy</span></div>' +
      '<pre><span class="k">from</span> openai <span class="k">import</span> OpenAI\n\n' +
      'client = OpenAI(\n' +
      '    base_url=os.environ[<span class="s">"STUDIO_BASE_URL"</span>],\n' +
      '    api_key=os.environ[<span class="s">"STUDIO_API_KEY"</span>],\n' +
      ')\n\n' +
      'r = client.chat.completions.<span class="f">create</span>(\n' +
      '    model=<span class="s">"qwen3-8b-support"</span>,\n' +
      '    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: q}],\n' +
      ')\n' +
      '<span class="k">print</span>(r.choices[<span class="c">0</span>].message.content)</pre></div>';

    h += '<div class="resp"><div class="hh"><span class="chip grn">' + dotc('#00a97a', 6) + '200 OK</span>' +
      '<span class="mono">1.24 s · 34 tokens</span></div>' +
      '<div class="bd" data-id="resp"></div></div></div>';
    return h + '</div></div>';
  }

  var RESP_TXT = '{\n' +
    '  "model": "qwen3-8b-support",\n' +
    '  "choices": [{ "message": { "role": "assistant",\n' +
    '      "content": "Set the retry budget to 3 attempts and escalate\\nafter 15 minutes without an owner." } }],\n' +
    '  "usage": { "prompt_tokens": 61, "completion_tokens": 34 }\n' +
    '}';

  /* ---- API keys */
  function pageKeys() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>API keys</h1>' +
      '<div class="sub">Create and manage account-level API keys used across your workspaces.</div>' +
      '<div class="acts"><div class="btn"><span data-id="spin5" style="display:flex">' + ic('refresh', 14) + '</span>' +
      '<span class="p">Refresh</span></div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Create key</span></div></div></div>';

    h += '<div class="tbl"><div class="th"><div class="c" style="width:360px">Credential</div>' +
      '<div class="c" style="width:210px">Access</div><div class="c" style="width:170px">Rate limits</div>' +
      '<div class="c" style="width:150px">Expires</div><div class="c" style="flex:1">Actions</div></div>';
    h += '<div class="tr" style="height:76px" data-id="krow"><div class="c" style="width:360px">' +
      '<div><div class="nm">MIdBg Debug Default Key</div>' +
      '<div class="mut mono" style="margin-top:3px;font-size:12px">sk-5b963…c7a</div></div>' +
      '<span class="chip">Default</span></div>' +
      '<div class="c" style="width:210px"><span class="chip">' + ic('shield', 11, 2) + 'Protected</span></div>' +
      '<div class="c" style="width:170px"><span class="mut">No limits</span></div>' +
      '<div class="c" style="width:150px"><span class="mut">Never</span></div>' +
      '<div class="c" style="flex:1;color:#a3a8af">' + ic('dots', 15) + '</div></div>';
    h += '</div>';

    h += '<div class="code" style="margin-top:22px"><div class="cb">' + ic('key', 13) +
      '<span class="t">How this key is used</span><span class="cp">Copy</span></div>' +
      '<pre><span class="k">export</span> STUDIO_API_KEY=<span class="s">sk-5b963…c7a</span>\n' +
      '<span class="c"># every request to a Token Factory endpoint carries it</span>\n' +
      'Authorization: <span class="f">Bearer</span> sk-5b963…c7a</pre></div>';
    return h + '</div>';
  }

  /* ---------------------------------------------------------------- pages */
  var PAGES = {
    zoo:      function () { return sidebar('UnieAI Model Zoo') + '<main class="pn">' + topbar('Token Factory') + pageZoo() + '</main>'; },
    play:     function () { return sidebar('Playground') + '<main class="pn">' + topbar('Token Factory') + pagePlay() + '</main>'; },
    tune:     function () { return sidebar('Fine-tuning') + '<main class="pn">' + topbar('Token Factory') + pageTune() + '</main>'; },
    jobs:     function () { return sidebar('Fine-tuning') + '<main class="pn">' + topbar('Token Factory') + pageJobs() + '</main>'; },
    endpoint: function () { return sidebar('Inference endpoints') + '<main class="pn">' + topbar('Token Factory') + pageEndpoint() + '</main>'; },
    keys:     function () { return sidebar('API keys') + '<main class="pn">' + topbar('Token Factory') + pageKeys() + '</main>'; },
    wide:     function () { return sidebar('UnieAI Model Zoo') + '<main class="pn">' + topbar('Token Factory') + pageZoo() + '</main>'; }
  };

  /* ---------------------------------------------------------------- camera */
  /* 8 shots, 4.8 s each: every cut lands on a bar line of the 100 BPM score */
  var SHOTS = [
    { t0: 0.0,  t1: 4.8,  pg: 'zoo',      m0: 1.42, m1: 1.49, p: 27, r0: 8.6,  r1: 11.2, y: -5.0, fx: 726, fy: 430 },
    { t0: 4.8,  t1: 9.6,  pg: 'zoo',      m0: 2.02, m1: 2.10, p: 34, r0: -10.2, r1: -7.0, y: 6.5, fx: 588, fy: 372 },
    /* the frame follows the conversation down as the second turn lands */
    { t0: 9.6,  t1: 14.4, pg: 'play',     m0: 1.74, m1: 1.52, p: 28, r0: 9.4,  r1: 6.6,  y: -6.5, fx: 900, fy: 430, fy1: 792 },
    { t0: 14.4, t1: 19.2, pg: 'tune',     m0: 1.34, m1: 1.41, p: 26, r0: -8.8, r1: -11.4, y: 5.5, fx: 726, fy: 470 },
    { t0: 19.2, t1: 24.0, pg: 'jobs',     m0: 1.88, m1: 1.96, p: 36, r0: 10.4, r1: 7.2,  y: -7.0, fx: 790, fy: 452 },
    { t0: 24.0, t1: 28.8, pg: 'endpoint', m0: 1.72, m1: 1.80, p: 32, r0: -10.6, r1: -7.4, y: 6.8, fx: 800, fy: 500 },
    { t0: 28.8, t1: 33.6, pg: 'keys',     m0: 1.96, m1: 2.04, p: 33, r0: 9.0,  r1: 12.0, y: -6.0, fx: 690, fy: 470 },
    { t0: 33.6, t1: 38.4, pg: 'wide',     m0: 1.00, m1: 1.04, p: 8,  r0: 0.8,  r1: 0.2,  y: 1.2, fx: 726, fy: 470 }
  ];

  function shotAt(t) {
    var s = SHOTS[SHOTS.length - 1];
    for (var i = 0; i < SHOTS.length; i++) {
      if (t >= SHOTS[i].t0 && t < SHOTS[i].t1) { s = SHOTS[i]; break; }
    }
    return s;
  }

  function camAt(t) {
    var s = shotAt(t);
    var p = cl((t - s.t0) / (s.t1 - s.t0), 0, 1);
    var e = eo(p);
    return {
      /* FLAT=1 renders the slab square-on, for layout checks only */
      flat: location.search.indexOf('flat') >= 0,
      S: lerp(s.m0, s.m1, e),
      p: s.p, y: s.y, r: lerp(s.r0, s.r1, e),
      /* the frame never stops moving, even when the move is done */
      fx: s.fx + Math.sin(t * 0.63 + 1.1) * 3.1,
      fy: lerp(s.fy, s.fy1 || s.fy, e) + Math.cos(t * 0.51) * 2.6,
      nb: s.nb, fb: s.fb, bd: s.bd || 150
    };
  }

  var DOF = false;   /* the client asked for no depth-of-field blur: one sharp plane */
  var maskCache = {};
  function bandCss(fy, band, mode) {
    var key = mode + Math.round(fy) + '_' + Math.round(band);
    if (maskCache[key]) return maskCache[key];
    var st = [], N = 28;
    for (var i = 0; i <= N; i++) {
      var yy = i / N * 950, o;
      if (mode === 'sharp') o = 1 - ss(1.0, 2.3, Math.abs(yy - fy) / band);
      else if (mode === 'near') o = yy < fy ? ss(1.0, 2.9, (fy - yy) / band) : 0;
      else o = yy > fy ? ss(1.0, 2.9, (yy - fy) / band) : 0;
      st.push('rgba(0,0,0,' + o.toFixed(3) + ') ' + (i / N * 100).toFixed(2) + '%');
    }
    var css = 'linear-gradient(to bottom, ' + st.join(', ') + ')';
    maskCache[key] = css;
    return css;
  }

  /* ---------------------------------------------------------------- film */
  function Film(stage) {
    this.stage = stage;
    this.stack = stage.querySelector('#stack');
    this.camera = stage.querySelector('#camera');
    this.ground = stage.querySelector('#ground');
    this.outro = stage.querySelector('#outro');
    this.wash = stage.querySelector('#wash');
    this.copyEl = stage.querySelector('#copy');
    this.words = Array.prototype.slice.call(stage.querySelectorAll('#copy .w'));
    this.endEl = stage.querySelector('#end');
    this.endMark = this.endEl.querySelector('.mark');
    this.endNm = this.endEl.querySelector('.nm');
    this.endTg = this.endEl.querySelector('.tg');

    this.copies = [];
    for (var i = 0; i < (DOF ? 3 : 1); i++) {
      var plane = document.createElement('div');
      plane.className = 'plane';
      plane.style.width = '1440px';
      plane.style.height = '950px';
      plane.style.position = 'absolute';
      plane.style.left = '0';
      plane.style.top = '0';
      var cast = document.createElement('div');
      cast.className = 'cast';
      cast.style.transform = 'translate3d(0,26px,0)';
      cast.style.filter = 'blur(11px)';
      var win = document.createElement('div');
      win.className = 'win';
      win.style.width = '1440px';
      win.style.height = '950px';
      var slab = document.createElement('div');
      slab.className = 'slab';
      win.appendChild(slab);
      plane.appendChild(cast);
      plane.appendChild(win);
      this.stack.appendChild(plane);
      this.copies.push({ plane: plane, win: win, cast: cast, slab: slab, page: null, ref: null });
    }
    this.tierMode = ['sharp', 'near', 'far'];
  }

  Film.prototype.ensure = function (c, page) {
    if (c.page === page) return;
    c.slab.innerHTML = PAGES[page]();
    c.page = page;
    this.collect(c);
  };

  Film.prototype.collect = function (c) {
    var ids = ['mc0', 'mc1', 'use0', 'spin', 'spin2', 'spin3', 'spin4', 'spin5',
      'ans', 'anscode', 'ans2', 'ans3', 'u2', 'a2', 'isoM', 'isoD', 'cost', 'go', 'fl', 'ep', 'loss', 'resp', 'krow'];
    var d = {};
    for (var i = 0; i < ids.length; i++) d[ids[i]] = c.slab.querySelector('[data-id="' + ids[i] + '"]');
    c.ref = d;
  };

  Film.prototype.render = function (t) {
    t = cl(t, 0, DUR);

    /* the light never stops moving either */
    this.ground.style.transform = 'translate(' + n2(Math.sin(t / 11) * 8) + 'px,' +
      n2(Math.cos(t / 13) * 7) + 'px) scale(1.05)';

    this.outro.style.visibility = t >= T_COPY - 0.12 ? 'visible' : 'hidden';
    this.wash.style.opacity = ss(T_COPY - 0.05, T_COPY + 1.45, t).toFixed(3);

    var camD = ss(T_COPY + 0.05, T_COPY + 1.25, t);
    this.camera.style.opacity = (1 - camD * 0.94).toFixed(3);
    this.camera.style.filter = 'none';

    var shot = shotAt(t);
    var page = shot.pg;
    var lt = t - shot.t0;
    var cam = camAt(t);
    if (cam.flat) {
      cam.S = lerp(0.86, 0.87, eo(cl((t - shot.t0) / (shot.t1 - shot.t0), 0, 1)));
      cam.p = 0; cam.y = 0; cam.r = 0; cam.fx = 720; cam.fy = 475; cam.bd = 6000;
    }
    var S = cam.S;
    var band = cam.bd / S;

    var tf = 'translate3d(' + n2(960 - cam.fx) + 'px,' + n2(540 - cam.fy) + 'px,0) ' +
      'rotateX(' + cam.p + 'deg) rotateY(' + cam.y + 'deg) rotateZ(' + n2(cam.r) + 'deg) ' +
      'scale(' + S.toFixed(5) + ')';
    var castBlur = n2(13 / S) + 'px';

    for (var ci = 0; ci < this.copies.length; ci++) {
      var c = this.copies[ci];
      this.ensure(c, page);

      c.plane.style.transformOrigin = n2(cam.fx) + 'px ' + n2(cam.fy) + 'px';
      c.plane.style.transform = tf;
      c.cast.style.filter = 'blur(' + castBlur + ')';

      var mode = this.tierMode[ci];
      var mk = DOF ? bandCss(cam.fy, band, mode) : 'none';
      c.plane.style.webkitMaskImage = mk;
      c.plane.style.maskImage = mk;
      c.plane.style.filter = (DOF && ci > 0)
        ? 'blur(' + n2((ci === 1 ? cam.nb : cam.fb) / S) + 'px)' : 'none';

      var r = c.ref;

      /* ---- model zoo: the "Use base model" press */
      if (page === 'zoo' || page === 'wide') {
        if (r.spin) r.spin.style.transform = 'rotate(' + ((t * 200) % 360).toFixed(1) + 'deg)';
        var hit = (page === 'zoo' && shot.t0 > 4) ? ss(2.55, 2.85, lt) : 0;
        if (r.mc0) {
          r.mc0.style.borderColor = hit > 0.5 ? '#c3bff2' : '#ececee';
          r.mc0.style.boxShadow = hit > 0.02
            ? '0 0 0 ' + n2(3 * hit) + 'px rgba(94,106,210,' + n2(0.10 * hit) + ')' : 'none';
        }
        if (r.use0) r.use0.style.color = hit > 0.5 ? '#5b4bd8' : '#3a4046';
      }

      /* ---- playground: the answer streams in */
      if (page === 'play' && r.ans) {
        var nA = Math.floor(cl((lt - 0.28) / 1.72, 0, 1) * ANS_A.length);
        r.ans.textContent = ANS_A.slice(0, nA);
        var blk = r.anscode;
        if (blk) blk.style.opacity = ss(2.02, 2.30, lt).toFixed(3);
        var nB = Math.floor(cl((lt - 2.30) / 0.86, 0, 1) * ANS_B.length);
        if (r.ans2) r.ans2.textContent = ANS_B.slice(0, nB);
        if (r.u2) r.u2.style.opacity = ss(3.22, 3.46, lt).toFixed(3);
        if (r.a2) r.a2.style.opacity = ss(3.30, 3.52, lt).toFixed(3);
        var nC = Math.floor(cl((lt - 3.46) / 0.92, 0, 1) * ANS_C.length);
        if (r.ans3) r.ans3.textContent = ANS_C.slice(0, nC);
        var live = (nA < ANS_A.length && lt > 0.28) ? r.ans
          : (nB > 0 && nB < ANS_B.length ? r.ans2
          : (nC > 0 && nC < ANS_C.length ? r.ans3 : null));
        var oldCb = c.slab.querySelector('.caret-bar');
        if (oldCb && oldCb.parentElement !== live) {
          oldCb.parentElement.removeChild(oldCb);
          oldCb = null;
        }
        if (live) {
          if (!oldCb) {
            oldCb = document.createElement('span');
            oldCb.className = 'caret-bar';
            live.appendChild(oldCb);
          }
          oldCb.style.opacity = (Math.floor(t * 2.6) % 2) ? '1' : '0.12';
        } else if (oldCb) {
          oldCb.style.opacity = '0';
        }
      }

      /* ---- fine-tuning form */
      if (page === 'tune') {
        if (r.spin2) r.spin2.style.transform = 'rotate(' + ((t * 200) % 360).toFixed(1) + 'deg)';
        if (r.isoM) {
          r.isoM.style.borderColor = lt > 0.9 ? '#c3bff2' : '#e2e2e4';
          r.isoM.style.boxShadow = lt > 0.9 ? '0 0 0 3px rgba(94,106,210,0.10)' : 'none';
        }
        if (r.isoD) {
          r.isoD.style.borderColor = lt > 1.9 ? '#c3bff2' : '#e2e2e4';
          r.isoD.style.boxShadow = lt > 1.9 ? '0 0 0 3px rgba(94,106,210,0.10)' : 'none';
        }
        if (r.cost) {
          r.cost.textContent = lt > 2.6 ? '$3.40' : '—';
          r.cost.style.color = lt > 2.6 ? '#12141a' : '#a8adb4';
        }
        if (r.go) {
          var g = ss(3.35, 3.75, lt);
          r.go.style.background = g > 0.5 ? '#4f4bbd' : '#5e6ad2';
          r.go.style.transform = 'scale(' + n2(1 - 0.012 * g).toFixed(4) + ')';
        }
      }

      /* ---- jobs: a run in progress */
      if (page === 'jobs') {
        if (r.spin3) r.spin3.style.transform = 'rotate(' + ((t * 260) % 360).toFixed(1) + 'deg)';
        var pr = cl(0.58 + lt * 0.052, 0, 0.86);
        if (r.fl) r.fl.style.width = (pr * 100).toFixed(1) + '%';
        if (r.ep) {
          var ep = pr < 0.66 ? 1 : 2;
          r.ep.textContent = 'Epoch ' + ep + ' / 3';
        }
        if (r.loss) r.loss.textContent = (1.284 - lt * 0.026).toFixed(3);
      }

      /* ---- endpoint: the response comes back */
      if (page === 'endpoint') {
        if (r.spin4) r.spin4.style.transform = 'rotate(' + ((t * 200) % 360).toFixed(1) + 'deg)';
        if (r.resp) {
          var m = Math.floor(cl((lt - 1.05) / 2.1, 0, 1) * RESP_TXT.length);
          r.resp.textContent = RESP_TXT.slice(0, m);
        }
      }

      /* ---- api keys */
      if (page === 'keys') {
        if (r.spin5) r.spin5.style.transform = 'rotate(' + ((t * 200) % 360).toFixed(1) + 'deg)';
        if (r.krow) {
          var gl = ss(0.9, 1.3, lt);
          r.krow.style.background = gl > 0.02 ? 'rgba(94,106,210,' + n2(0.045 * gl) + ')' : '#fff';
          r.krow.style.boxShadow = gl > 0.02
            ? 'inset 0 0 0 1px rgba(94,106,210,' + n2(0.22 * gl) + ')' : 'none';
        }
      }
    }

    /* ---- copy line */
    for (var w = 0; w < this.words.length; w++) {
      var st0 = T_COPY + 0.22 + w * 0.15;
      var o = ss(st0, st0 + 0.8, t);
      var rise = (1 - eo(cl((t - st0) / 0.9, 0, 1))) * 16;
      var out = ss(T_END - 0.98, T_END - 0.58, t);
      this.words[w].style.opacity = (o * (1 - out)).toFixed(3);
      this.words[w].style.transform = 'translateY(' + n2(rise - out * 12) + 'px)';
    }

    /* ---- end card */
    var showEnd = t >= T_END - 0.8;
    this.endEl.style.opacity = showEnd ? '1' : '0';
    if (showEnd) {
      this.endEl.style.transform = 'scale(' + (1 + 0.014 * ss(T_END, DUR, t)).toFixed(4) + ')';
      this.endMark.style.opacity = ss(T_END - 0.7, T_END - 0.1, t).toFixed(3);
      this.endMark.style.transform = 'translateY(' + n2((1 - eo(cl((t - (T_END - 0.7)) / 0.65, 0, 1))) * 12) + 'px)';
      this.endNm.style.opacity = ss(T_END - 0.48, T_END + 0.1, t).toFixed(3);
      this.endTg.style.opacity = ss(T_END - 0.18, T_END + 0.45, t).toFixed(3);
      this.endTg.style.transform = 'translateY(' + n2((1 - eo(cl((t - (T_END - 0.18)) / 0.7, 0, 1))) * 10) + 'px)';
    }
  };

  window.Film = Film;
  window.DUR = DUR;
})();
