// The two rabi capabilities uac switches on by itself: cross-session search and
// the Ralph loop. Both are plain patch rows in config.mjs, so the test is about
// the generated YAML — rabi rejects a patch row that does not restate the whole
// config of an existing plugin, and a row that silently disappears leaves the
// tool list short without anything failing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPatch, selectPlugins } from "./config.mjs";

const patch = (options = {}) =>
  renderPatch({ defaultModel: "A", plugins: selectPlugins({}), home: "/h", ...options });

test("session search: the index plugin is switched on at first search, not at boot", () => {
  const text = patch();
  // rabi's base profile mounts this plugin `openAt: never`, which is why the
  // session tools were registered but could answer nothing. A patch row
  // replaces the plugin's whole config object, so `path` has to be restated.
  assert.match(text, /^- id: session-query-sqlite\n {2}config:\n {4}path: ':memory:'\n {4}openAt: first-search$/m);
  // 'file:'/'sqlite:' — a typo here would put an index file in the rabi home.
  assert.match(text, /^ {4}- id: tool-session-query\n {6}name: '@unieai\/rabi-tool-session-query'$/m);
});

test("ralph: inserted over the profile's own subagent provider, with a round cap", () => {
  const text = patch();
  assert.match(text, /^ {4}- id: tool-ralph\n {6}name: '@unieai\/rabi-tool-ralph'\n {6}config:\n {8}subagentProvider: spawn\n {8}maxRounds: 64$/m);
  // The bundle rabi ships also brings its own workflow engine; the ACP profile
  // already has one over `spawn`, so only the tool is inserted.
  assert.doesNotMatch(text, /rabi-experimental-ralph-bundle/);
});

test("minimal mode leaves only the inert disable row, never the tools themselves", () => {
  const text = patch({ mode: "minimal" });
  assert.match(text, /^- id: tool-ralph\n {2}disabled: true$/m);
  assert.doesNotMatch(text, /@unieai\/rabi-tool-ralph|@unieai\/rabi-tool-session-query/);
  // Nothing else would build the index in minimal mode, so the plugin stays as
  // the profile mounts it.
  assert.doesNotMatch(text, /openAt: first-search/);
});
