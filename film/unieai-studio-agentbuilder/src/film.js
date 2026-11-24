/* UnieAI Studio — Agent Builder film.
   Every frame is a pure function of t. No animation CSS, no timeouts,
   no transition: the renderer sets all state from t each frame.        */
(function () {
  'use strict';

  var DUR = 52.0;

  /* ---------------------------------------------------------------- utils */
  function cl(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ss(a, b, x) { var t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function eo(t) { return 1 - Math.pow(1 - cl(t, 0, 1), 3); }
  function ei(t) { return Math.pow(cl(t, 0, 1), 3); }
  function n2(x) { return Math.round(x * 100) / 100; }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- icons */
  var P = {
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    key: '<circle cx="7.5" cy="15.5" r="5"/><path d="m21 3-9.5 9.5"/><path d="m15.5 8 3 3 2.5-2.5-3-3"/>',
    bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    sparkle: '<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
    db: '<ellipse cx="12" cy="5" rx="8.5" ry="2.8"/><path d="M3.5 5v14c0 1.6 3.8 2.8 8.5 2.8s8.5-1.2 8.5-2.8V5"/><path d="M3.5 12c0 1.6 3.8 2.8 8.5 2.8s8.5-1.2 8.5-2.8"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
    plug: '<path d="M12 22v-4.5"/><path d="M9 8V2.5"/><path d="M15 8V2.5"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    win: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M2.5 9h19"/>',
    store: '<path d="m2.5 7 1.6-4h15.8l1.6 4"/><path d="M2.5 7h19v2.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z"/><path d="M4.5 12v9h15v-9"/>',
    msg: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-4.6a8.4 8.4 0 0 1-.9-3.9A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z"/>',
    globe: '<circle cx="12" cy="12" r="9.3"/><path d="M2.7 12h18.6"/><path d="M12 2.7a14 14 0 0 1 0 18.6 14 14 0 0 1 0-18.6Z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    net: '<rect x="9" y="2.5" width="6" height="6" rx="1.5"/><rect x="2" y="15.5" width="6" height="6" rx="1.5"/><rect x="16" y="15.5" width="6" height="6" rx="1.5"/><path d="M12 8.5V12M5 15.5V12h14v3.5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.3"/><path d="m19.8 19.8-4.4-4.4"/>',
    updown: '<path d="m8 9 4-4 4 4"/><path d="m8 15 4 4 4-4"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9h-5.5"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2.4"/><path d="M9 3v18"/>',
    sliders: '<path d="M4 6.5h7M16.5 6.5H20M4 12h3M12.5 12H20M4 17.5h9M17.5 17.5H20"/><circle cx="14" cy="6.5" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="15" cy="17.5" r="2"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    dots: '<circle cx="12" cy="5.5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="12" cy="18.5" r="1.1"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2.2"/><path d="M9 3v18M3 9h18"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    gauge: '<path d="M12 13.5 15.5 10"/><path d="M3.6 17.5a9 9 0 1 1 16.8 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    graph: '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="9" r="2.4"/><circle cx="11" cy="18" r="2.4"/><path d="M8 8.2 15.6 8.8M7.4 9.2l2.8 6.4"/>'
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

  /* ---------------------------------------------------------------- brand */
  /* the product's own sidebar lockup: two black shapes, 19px */
  var MARK_SM =
    '<svg class="mk" viewBox="0 0 19 19" fill="none">' +
    '<path d="M2.1 11.7 15.4 3.1l1.5 2.6L3.6 14.3z" fill="#12141a"/>' +
    '<rect x="2.6" y="11.4" width="13.6" height="5.4" rx="2.7" fill="#12141a"/>' +
    '</svg>';

  /* ---------------------------------------------------------------- data */
  var AGENTS = [
    { n: 'budget-analyst', m: 'DeepSeek-V4.1-Flash', c: 'YC Lin', on: 1, k: '840' },
    { n: 'project-brief-reader', m: 'Qwen3.6-35B-A3B', c: 'MIdBg Debug', on: 1, k: '512' },
    { n: 'vendor-intake', m: 'gemma-4-31B-it', c: 'YC Lin', on: 1, k: '97' },
    { n: 'audit-copilot', m: 'Qwen3.6-35B-A3B', c: 'MIdBg Debug', on: 0, k: '0' },
    /* the agent this film builds: it exists only after `Create Agent` */
    { n: 'contracts-qa', m: 'Qwen3.6-35B-A3B', c: 'YC Lin', on: 1, k: '0' }
  ];

  /* ---------------------------------------------------------------- graph */
  function sidebar(active) {
    var items = [
      { g: null, y: 182, t: 'Usage', ic: 'activity' },
      { g: null, y: 220, t: 'API keys', ic: 'key' },
      { g: 'Agent Builder', y: 266 },
      { y: 288, t: 'My Agents', ic: 'bot', id: 'My Agents' },
      { g: 'My assets', y: 342 },
      { y: 364, t: 'Knowledge bases', ic: 'book', id: 'Knowledge bases' },
      { y: 402, t: 'Skills', ic: 'sparkle', id: 'Skills' },
      { y: 440, t: 'Databases', ic: 'db', id: 'Databases' },
      { y: 478, t: 'API tools', ic: 'plug', id: 'API tools' },
      { y: 516, t: 'MCP servers', ic: 'grid', id: 'MCP servers' },
      { y: 554, t: 'Third-party apps', ic: 'win', id: 'Third-party apps' },
      { y: 592, t: 'Asset marketplace', ic: 'store', id: 'Asset marketplace' }
    ];
    var h = '<aside class="sb">';
    h += '<div class="logo">' + MARK_SM + '<span class="nm">UnieAI Studio</span></div>';
    h += '<div class="ws">' + ic('shield', 14) + '<span class="lb">Personal Space</span>' +
      '<span class="ch">' + ic('updown', 12, 2) + '</span></div>';
    h += '<div class="srch">' + ic('search', 13) + '<span class="q">Search</span><span class="kbd mono">⌘K</span></div>';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.g) h += '<div class="grp" style="top:' + it.y + 'px">' + it.g + '</div>';
      else h += '<div class="it' + (it.id === active ? ' on' : '') + '" style="top:' + it.y + 'px">' +
        '<span class="ic">' + ic(it.ic, 16) + '</span><span class="tx">' + it.t + '</span></div>';
    }
    h += '<div class="hr" style="top:722px"></div>';
    var foot = [
      ['Documentation', 'book'], ['UnieAI official website', 'globe'], ['Discord', 'msg'],
      ['Admin panel', 'shield'], ['Compute provider', 'net']
    ];
    for (var j = 0; j < foot.length; j++) {
      h += '<div class="it" style="top:' + (748 + j * 38) + 'px">' +
        '<span class="ic">' + ic(foot[j][1], 15) + '</span><span class="tx">' + foot[j][0] + '</span></div>';
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

  function pageAgents(n) {
    var rows = AGENTS.slice(0, n);
    var h = '<div class="pg">';
    h += '<div class="pillnav" style="top:22px"><div class="p">My Models</div>' +
      '<div class="p on">My Agents <span class="cnt">' + n + '</span></div></div>';
    h += '<div class="head" style="padding-top:74px">' +
      '<h1>My Agents</h1>' +
      '<div class="sub">Agents you have built. Each one answers from the data you gave it.</div>' +
      '<div class="acts">' +
      '<div class="btn ico">' + ic('dots', 15) + '</div>' +
      '<div class="btn">' + ic('refresh', 14) + '<span class="p">Refresh</span></div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Create agent</span></div>' +
      '</div></div>';
    h += '<div class="cards">' +
      '<div class="card"><div class="tile">' + ic('bot', 16) + '</div><div><div class="t">Build from a template</div>' +
      '<div class="d">Contracts, reporting, audit — pick a starting point.</div></div></div>' +
      '<div class="card"><div class="tile vio">' + ic('plus', 16, 2) + '</div><div><div class="t">Create your own</div>' +
      '<div class="d">Choose a base model, tools and the scope it may read.</div></div></div>' +
      '<div class="card"><div class="tile">' + ic('gauge', 16) + '</div><div><div class="t">View others\' agents</div>' +
      '<div class="d">Templates shared with your group.</div></div></div>' +
      '</div>';
    h += '<div class="strip" style="margin-top:20px"><div class="s on">Agents</div>' +
      '<div class="s">Sandboxes</div><div class="s">Sessions <span class="soon">coming soon</span></div></div>';
    h += '<div class="tbar"><div class="sel">All statuses' + ic('chev', 12, 2) + '</div>' +
      '<div class="sel">Created by anyone' + ic('chev', 12, 2) + '</div>' +
      '<div class="seg"><div class="g on">' + ic('list', 13) + 'List</div><div class="g">' + ic('grid', 12) + 'Table</div></div></div>';

    h += '<div class="tbl"><div class="th"><div class="c" style="width:326px">Name</div>' +
      '<div class="c" style="width:270px">Base model</div><div class="c" style="width:150px">Creator</div>' +
      '<div class="c" style="width:110px">Sessions</div><div class="c" style="width:120px">Status</div>' +
      '<div class="c" style="flex:1"></div></div>';
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      h += '<div class="tr' + (a.n === 'contracts-qa' ? ' new' : '') + '"><div class="c" style="width:326px"><div>' +
        '<div class="nm">' + a.n + '</div>' +
        '<div class="mut" style="margin-top:2px">' +
        (a.n === 'contracts-qa' ? 'Draft · just created' : 'Published · updated 2 days ago') +
        '</div></div></div>' +
        '<div class="c" style="width:270px"><span class="mdl">' + a.m + '</span></div>' +
        '<div class="c" style="width:150px"><span class="mut">' + a.c + '</span></div>' +
        '<div class="c" style="width:110px"><span class="mono" style="font-size:12.5px;color:#4d535a">' + a.k + '</span></div>' +
        '<div class="c" style="width:120px"><span class="chip' + (a.on ? ' grn' : '') + '">' +
        dotc(a.on ? '#00a97a' : '#b9bec4', 6) + (a.on ? 'Enabled' : 'Disabled') + '</span></div>' +
        '<div class="c" style="flex:1;justify-content:flex-end;color:#a3a8af">' + ic('dots', 15) + '</div></div>';
    }
    h += '</div>';
    h += '<div class="foot">' + n + ' agents · 3 run on Qwen3.6-35B-A3B<div class="r">' +
      '<span>View others\' agents</span><span>Refresh</span></div></div>';
    return h + '</div>';
  }

  function pageSources() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>Data sources</h1>' +
      '<div class="sub">Connect a read-only database so your agents can query and analyze it.</div>' +
      '<div class="acts"><div class="btn ico">' + ic('dots', 15) + '</div>' +
      '<div class="btn">' + ic('refresh', 14) + '<span class="p">Refresh</span></div>' +
      '<div class="btn vio">' + ic('plus', 14, 2) + '<span class="p">Add data</span></div></div></div>';

    h += '<div class="tbl"><div class="th"><div class="c" style="width:430px">Connection</div>' +
      '<div class="c" style="width:250px">Engine</div><div class="c" style="width:150px">Tables</div>' +
      '<div class="c" style="width:180px">Relationships</div><div class="c" style="width:190px">Status</div>' +
      '<div class="c" style="flex:1"></div></div>';

    /* the row that is being introspected while we watch */
    h += '<div class="tr srow" style="background:#fcfcff">' +
      '<div class="c" style="width:430px"><div>' +
      '<div class="conn">erp_prod</div>' +
      '<div class="url mono">postgres://studio_readonly@erp.internal:5432/erp</div></div></div>' +
      '<div class="c" style="width:250px"><span class="mdl">PostgreSQL 16</span>' +
      '<span class="chip">' + ic('lock', 10, 2) + 'Read-only</span></div>' +
      '<div class="c" style="width:150px"><span class="num mono" data-id="s-tbl">—</span>' +
      '<span class="mut" style="font-size:12px">tables</span></div>' +
      '<div class="c" style="width:180px"><span class="num sm mono" data-id="s-rel">—</span>' +
      '<span class="mut" style="font-size:12px">joins</span></div>' +
      '<div class="c" style="width:190px"><span class="chip" data-id="s-status">' +
      '<span data-id="s-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#00a97a;opacity:0"></span>' +
      '<span class="spin" data-id="s-spin" style="display:inline-block"></span>' +
      '<span data-id="s-text">Introspecting…</span></span></div>' +
      '<div class="c" style="flex:1;justify-content:flex-end;color:#a3a8af">' + ic('dots', 15) + '</div></div>';

    h += '<div class="tr srow">' +
      '<div class="c" style="width:430px"><div>' +
      '<div class="conn">crm_mirror</div>' +
      '<div class="url mono">mysql://studio_readonly@crm.internal:3306/crm</div></div></div>' +
      '<div class="c" style="width:250px"><span class="mdl">MySQL 8.0</span>' +
      '<span class="chip">' + ic('lock', 10, 2) + 'Read-only</span></div>' +
      '<div class="c" style="width:150px"><span class="num mono">42</span>' +
      '<span class="mut" style="font-size:12px">tables</span></div>' +
      '<div class="c" style="width:180px"><span class="num sm mono">96</span>' +
      '<span class="mut" style="font-size:12px">joins</span></div>' +
      '<div class="c" style="width:190px"><span class="chip grn">' + dotc('#00a97a', 6) + 'Connected</span></div>' +
      '<div class="c" style="flex:1;justify-content:flex-end;color:#a3a8af">' + ic('dots', 15) + '</div></div>';
    h += '</div>';

    h += '<div class="foot">2 connections · synced 4 minutes ago<div class="r">' +
      '<span>Read-only access only</span></div></div>';

    /* what the introspection produced */
    h += '<div style="margin-top:22px;display:flex;gap:14px">' +
      '<div class="card" style="height:74px;flex:none;width:206px"><div class="tile">' + ic('db', 16) + '</div>' +
      '<div><div class="t">Schema mirrored</div><div class="d">erp_prod · public</div></div></div>' +
      '<div class="card" style="height:74px;flex:none;width:206px"><div class="tile">' + ic('graph', 16) + '</div>' +
      '<div><div class="t">218 foreign keys</div><div class="d">read from constraints</div></div></div>' +
      '<div class="card" style="height:74px;flex:none;width:206px"><div class="tile">' + ic('sparkle', 16) + '</div>' +
      '<div><div class="t">Semantics drafted</div><div class="d">0.8 s per table</div></div></div>' +
      '</div>';
    return h + '</div>';
  }

  /* the real New agent wizard: /agents/create, rebuilt from the live app.
     Stations, labels, helper text and the right-hand config panel are the
     product's own copy; only the demo values are ours.                     */
  var WZ_NAME = 'contracts-qa';
  var WZ_INSTR = 'You answer contract questions for the legal team.\n' +
    'Cite the clause and the document you used.\n' +
    'If a clause is not in the workspace, say so instead of guessing.';

  function pageCreate() {
    var h = '<div class="pg">';
    h += '<div class="head"><h1>New agent</h1>' +
      '<div class="sub">Runs on UnieAI Harness and returns results through an API. ' +
      'Define the engine, model, data sources, memory, guardrails and evaluation.</div>' +
      '<div class="acts"><div class="btn"><span class="p">Cancel</span></div></div>' +
      '</div>';

    h += '<div class="wz">';

    /* ---------------------------------------------------------- left column */
    h += '<div class="colL">';

    h += '<div class="st"><div class="hd"><span class="t">Agent definition</span>' +
      '<span class="hint">Name and system instructions.</span>' +
      '<span class="chip vio">Draft</span></div>' +
      '<div class="lbl">Name</div>' +
      '<div class="inp on" data-id="cz-namebox"><span data-id="cz-name"></span></div>' +
      '<div class="lbl">Instructions<span class="alt">System prompt</span></div>' +
      '<div class="ta" data-id="cz-tabox"><span data-id="cz-instr" class="ph">' +
      'Describe what this agent does, what it may read and how it should answer.' +
      '</span><span class="cur" data-id="cz-caret" style="opacity:0"></span></div>' +
      '<div class="ft"><span>Plain text</span><span>Variables</span>' +
      '<span class="r"><b data-id="cz-count">0</b> characters</span></div>' +
      '</div>';

    h += '<div class="st"><div class="hd"><span class="t">Model</span>' +
      '<span class="hint">Pick a built-in Model Zoo preset, or supply a base URL / API key / model name.</span>' +
      '</div>' +
      '<div class="optrow">' +
      '<div class="opt on"><div class="t">' + ic('grid', 13) + 'Model Zoo' +
      '<span class="tick" data-id="cz-tick">' + ic('check', 14, 2.2) + '</span></div>' +
      '<div class="d">Built-in, no key to manage</div></div>' +
      '<div class="opt"><div class="t">' + ic('bot', 13) + 'Agent</div>' +
      '<div class="d">base URL + key + name</div></div>' +
      '</div>' +
      '<div class="mzk"><span class="k">Model Zoo model</span>' +
      '<span class="v">Qwen3.6-35B-A3B</span>' +
      '<span class="c">' + ic('chev', 15) + '</span></div>' +
      '<div class="note">Choose a base model that supports function calling / tool calling. ' +
      'Agentic RAG planner now requires structured function calls and may fail with models ' +
      'that only return plain text.</div>' +
      '<div class="note">Built-in / fine-tuned models from Token Factory; billed per token to your wallet.</div>' +
      '</div>';

    h += '<div class="st"><div class="hd"><span class="t">Data sources</span>' +
      '<span class="hint">Pick the knowledge bases, skills, MCP servers, SQL connections, ' +
      'and API tools this agent may call at runtime.</span>' +
      '<span class="chip" data-id="cz-ds">0 selected</span></div>' +
      '<div class="dstrip" data-id="cz-tabs"><div class="s on">Knowledge Base</div><div class="s">Skills</div>' +
      '<div class="s">MCP</div><div class="s">SQL</div><div class="s">API</div></div>' +
      '<div class="empty" data-id="cz-dsline">No knowledge bases in this workspace</div>' +
      '</div>';

    h += '</div>';

    /* --------------------------------------------------------- right column */
    h += '<div class="colR">';
    h += '<div class="cfg"><div class="t">Agent config</div>' +
      '<div class="s">Definition · model · chat/completions</div>' +
      '<div class="r"><div class="k">BASE MODEL</div><div class="v">Qwen3.6-35B-A3B</div></div>' +
      '<div class="r"><div class="k">DISPLAY NAME</div><div class="v" data-id="cz-dn">' +
      'Qwen3.6-35B-A3B-fc5154</div></div>' +
      '<div class="r"><div class="k">WORKSPACE</div><div class="v">Personal space</div></div>' +
      '<div class="r"><div class="k">BASE MODEL ACCESS</div><div class="v mut">Add to My Models first</div></div>' +
      '<div class="r"><div class="k">DATA SOURCES</div><div class="v mut" data-id="cz-dsrc">' +
      'Not selected</div></div>' +
      '</div>';
    h += '<div class="cta"><div class="btn vio wide" data-id="cz-cta">' +
      ic('bot', 14) + '<span class="p">Create Agent</span></div></div>';
    h += '</div>';

    h += '</div>';
    return h + '</div>';
  }

  function pageHtml(p) {
    var inner = p === 'agents' ? pageAgents(4) : p === 'agents5' ? pageAgents(5) : pageCreate();
    return sidebar('My Agents') + '<main class="pn">' + topbar('Agent Builder') + inner + '</main>';
  }

  /* ---------------------------------------------------------------- camera */
  var SHOTS = [
    /* 1  the roster, before anything is built */
    { t0: 0.0, t1: 6.0, m0: 1.56, m1: 1.66, p: 27, r0: 8.4, r1: 11.4, y: -5.0, fx: 706, fy: 470, nb: 7.0, fb: 10.0 },
    /* 2  New agent: the name */
    { t0: 6.0, t1: 12.0, m0: 1.62, m1: 1.72, p: 31, r0: 9.4, r1: 6.4, y: -6.0, fx: 606, fy: 322, nb: 8.0, fb: 11.4 },
    /* 3  the instructions write themselves */
    { t0: 12.0, t1: 18.0, m0: 1.96, m1: 2.06, p: 33, r0: -9.8, r1: -6.8, y: 6.0, fx: 662, fy: 392, nb: 9.0, fb: 12.8 },
    /* 4  the model station: the Model Zoo preset confirms */
    { t0: 18.0, t1: 24.0, m0: 2.02, m1: 2.10, p: 33, r0: -10.2, r1: -7.2, y: 6.4, fx: 646, fy: 552, nb: 9.0, fb: 12.8 },
    /* 5  data sources: honest empty state */
    { t0: 24.0, t1: 30.0, m0: 1.74, m1: 1.82, p: 30, r0: 8.6, r1: 11.4, y: -5.6, fx: 690, fy: 700, nb: 8.4, fb: 12.0 },
    /* 6  the config rail and the button that ships it */
    { t0: 30.0, t1: 36.0, m0: 2.02, m1: 2.12, p: 32, r0: 8.2, r1: 11.4, y: -5.4, fx: 1192, fy: 392, fy1: 452, nb: 8.6, fb: 12.2 },
    /* 7  the payoff, wide: the new agent is in the roster */
    { t0: 36.0, t1: 42.0, m0: 1.06, m1: 1.10, p: 9, r0: 0.7, r1: 0.2, y: 1.2, fx: 720, fy: 476, nb: 5.0, fb: 7.0, bd: 430 }
  ];

  function camAt(t) {
    var s = SHOTS[SHOTS.length - 1];
    for (var i = 0; i < SHOTS.length; i++) {
      if (t >= SHOTS[i].t0 && t < SHOTS[i].t1) { s = SHOTS[i]; break; }
    }
    var p = cl((t - s.t0) / (s.t1 - s.t0), 0, 1);
    var e = eo(p);
    return {
      S: lerp(s.m0, s.m1, e),
      p: s.p, y: s.y, r: lerp(s.r0, s.r1, e),
      /* the frame never stops moving, even when the move is done */
      fx: s.fx + Math.sin(t * 0.63 + 1.1) * 3.1,
      fy: lerp(s.fy, s.fy1 || s.fy, e) + Math.cos(t * 0.51) * 2.6,
      nb: s.nb, fb: s.fb, bd: s.bd || 150,
      flat: location.search.indexOf('flat') >= 0
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
      var win = document.createElement('div');
      win.className = 'win';
      win.style.width = '1440px';
      win.style.height = '950px';
      var cast = document.createElement('div');
      cast.className = 'cast';
      cast.style.transform = 'translate3d(0,26px,0)';
      cast.style.filter = 'blur(11px)';
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
    c.slab.innerHTML = pageHtml(page);
    c.page = page;
    this.collect(c);
  };

  Film.prototype.collect = function (c) {
    var ids = ['s-tbl', 's-rel', 's-spin', 's-dot', 's-text', 'cz-name', 'cz-namebox',
      'cz-instr', 'cz-tabox', 'cz-caret', 'cz-count', 'cz-tick', 'cz-ds', 'cz-dsrc', 'cz-cta',
      'cz-tabs', 'cz-dsline'];
    var d = {};
    for (var i = 0; i < ids.length; i++) d[ids[i]] = c.slab.querySelector('[data-id="' + ids[i] + '"]');
    c.ref = { d: d };
  };

  Film.prototype.render = function (t) {
    t = cl(t, 0, DUR);

    /* the light never stops moving either */
    this.ground.style.transform = 'translate(' + n2(Math.sin(t / 11) * 8) + 'px,' +
      n2(Math.cos(t / 13) * 7) + 'px) scale(1.05)';

    this.outro.style.visibility = t >= 41.9 ? 'visible' : 'hidden';
    this.wash.style.opacity = ss(41.95, 43.5, t).toFixed(3);

    var camD = ss(42.05, 43.3, t);
    this.camera.style.opacity = (1 - camD * 0.94).toFixed(3);
    this.camera.style.filter = 'none';

    var page = t < 6.0 ? 'agents' : t < 36.0 ? 'create' : 'agents5';
    var cam = camAt(t);
    /* layout QA only: square-on slab, whole page in frame */
    if (cam.flat) {
      cam = { S: 0.86, p: 0, y: 0, r: 0, fx: 720, fy: 475, bd: 6000 };
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

      /* ---- per page, per frame state */
      var r = c.ref.d;

      /* the created agent lands at the foot of the roster */
      if (page === 'agents5') {
        var nr = c.slab.querySelector('.tr.new');
        if (nr) {
          var ip = ss(36.45, 37.35, t);
          nr.style.opacity = ip.toFixed(3);
          nr.style.transform = 'translateY(' + n2((1 - ip) * 12) + 'px)';
          nr.style.boxShadow = ip > 0.06 ? 'inset 0 0 0 100px rgba(94,106,210,' +
            (0.055 * ip).toFixed(3) + ')' : 'none';
        }
      }

      if (page === 'create' && r['cz-instr']) {
        /* the agent is written once, top to bottom: a name, then instructions.
           the count is the product's own character counter.                 */
        var T_NAME = 6.40, T_INSTR = 7.75;
        var nn = Math.floor(cl((t - T_NAME) / 1.15, 0, 1) * WZ_NAME.length);
        r['cz-name'].textContent = WZ_NAME.slice(0, nn);
        r['cz-namebox'].className = 'inp' + (t > T_NAME - 0.2 && t < T_INSTR - 0.35 ? ' on' : '');

        var ni = Math.floor(cl((t - T_INSTR) / 10.2, 0, 1) * WZ_INSTR.length);
        r['cz-instr'].textContent = ni > 0 ? WZ_INSTR.slice(0, ni)
          : 'Describe what this agent does, what it may read and how it should answer.';
        r['cz-instr'].className = ni > 0 ? '' : 'ph';
        r['cz-count'].textContent = String(ni);
        r['cz-tabox'].className = 'ta' + (t > T_INSTR - 0.35 && t < T_INSTR + 10.6 ? ' on' : '');

        var typing = t > T_NAME && nn < WZ_NAME.length || (t > T_INSTR && ni < WZ_INSTR.length);
        r['cz-caret'].style.opacity = typing ? ((Math.floor(t * 2.6) % 2) ? 1 : 0.12) : 0;

        /* the Model Zoo preset confirms itself once the model station is framed */
        r['cz-tick'].style.opacity = ss(20.35, 20.75, t).toFixed(3);

        /* the data-source strip is paged once while we hold on it: every
           type is real, and every one of them is still empty here */
        if (r['cz-tabs']) {
          var ax = t >= 26.5 ? 3 : 0;
          var kids = r['cz-tabs'].children;
          for (var k = 0; k < kids.length; k++) kids[k].className = 's' + (k === ax ? ' on' : '');
          if (r['cz-dsline']) {
            r['cz-dsline'].textContent = ax === 3
              ? 'No SQL connections in this workspace'
              : 'No knowledge bases in this workspace';
            r['cz-dsline'].style.opacity = (0.55 + 0.45 * ss(26.35, 26.7, t)).toFixed(3);
          }
        }
        var ctaOn = ss(33.1, 33.6, t);
        r['cz-cta'].style.filter = 'brightness(' + (1 + 0.06 * ctaOn).toFixed(3) + ')';
      }
    }

    /* ---- copy line */
    for (var w = 0; w < this.words.length; w++) {
      var st0 = 42.22 + w * 0.15;
      var o = ss(st0, st0 + 0.8, t);
      var rise = (1 - eo(cl((t - st0) / 0.9, 0, 1))) * 16;
      var out = ss(45.62, 46.02, t);
      this.words[w].style.opacity = (o * (1 - out)).toFixed(3);
      this.words[w].style.transform = 'translateY(' + n2(rise - out * 12) + 'px)';
    }

    /* ---- end card */
    var showEnd = t >= 45.8;
    this.endEl.style.opacity = showEnd ? '1' : '0';
    if (showEnd) {
      this.endEl.style.transform = 'scale(' + (1 + 0.014 * ss(46.0, 52.0, t)).toFixed(4) + ')';
      this.endMark.style.opacity = ss(45.9, 46.5, t).toFixed(3);
      this.endMark.style.transform = 'translateY(' + n2((1 - eo(cl((t - 45.9) / 0.65, 0, 1))) * 12) + 'px)';
      this.endNm.style.opacity = ss(46.12, 46.7, t).toFixed(3);
      this.endTg.style.opacity = ss(46.42, 47.05, t).toFixed(3);
      this.endTg.style.transform = 'translateY(' + n2((1 - eo(cl((t - 46.42) / 0.7, 0, 1))) * 10) + 'px)';
    }
  };

  window.Film = Film;
  window.DUR = DUR;
})();
