// Copyright (c) 2026 UnieAI. All rights reserved.
// Harness profiles: uac applies a profile exactly as the harness lab measured
// it (checked against what the lab's own Python produced for the fixtures in
// test-fixtures/harness-profiles), resolves the right one for a model, and
// never fails a start over a bad file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGINS } from "./uac-plugins/unieai-catalog.mjs";
import { BUNDLED_SKILLS_DIR, pluginEnv, prepareDsh, renderPatch, renderUacConfig, selectPlugins } from "./config.mjs";
import {
  BUNDLED_PROFILES_DIR,
  appendPersona,
  checkBundledProfiles,
  loadBundledProfiles,
  loadProfileFile,
  personaRigor,
  profileInstructions,
  profileLogLine,
  profilePluginChoice,
  profileSha,
  profileSkillFiles,
  resolveProfile,
  validateProfile,
} from "./unieai-profiles.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-fixtures", "harness-profiles");
const LAB = JSON.parse(readFileSync(join(FIXTURES, "lab-reference.json"), "utf8"));
const fixture = (name) => {
  const { profile, error } = loadProfileFile(join(FIXTURES, name));
  assert.equal(error, undefined);
  return profile;
};
const CATALOG = PLUGINS.map((plugin) => plugin.id);

test("the lab's plugin catalog is still uac's (regenerate lab-reference.json when it changes)", () => {
  assert.deepEqual(LAB.catalog, CATALOG);
});

for (const reference of LAB.cases) {
  test(`${reference.file}: applied byte for byte as the lab applies it`, () => {
    const profile = fixture(reference.file);
    assert.equal(profileSha(profile), reference.profile_sha, "profile_sha");
    const text = profileInstructions(profile);
    assert.equal(text, reference.instructions, "persona text");
    assert.equal(appendPersona(LAB.base_patch, text), reference.patched, "appended inside personaPrefix");
    assert.equal(appendPersona("", text), reference.patched_empty, "a system-prompt row when there is none");
    assert.deepEqual(profileSkillFiles(profile), reference.skill_files, "SKILL.md files");
    // The lab's catalog has no unieai-artifacts; uac's choice names it like a plugin.
    const choice = profilePluginChoice(profile, { catalog: CATALOG });
    const ids = choice === null ? null : choice === "off" ? [] : choice.split(",");
    const lab = reference.pack_env.UNIEAI_DSH_PLUGINS;
    assert.deepEqual(ids, lab === undefined ? null : lab === "off" ? [] : lab.split(","), "plugin choice");
    assert.equal(personaRigor(profile, {}), reference.pack_env.UNIEAI_PERSONA_RIGOR === "1", "persona level");
  });
}

test("the profile's persona text lands in uac's own persona row, nothing else changes", () => {
  const profile = { ...fixture("example.yaml"), persona: { level: "standard", extra: ["Check twice."] } };
  const plain = renderPatch({ defaultModel: "Example-Model-7B", plugins: selectPlugins({}) });
  const applied = renderPatch({ defaultModel: "Example-Model-7B", plugins: selectPlugins({}), profile });
  assert.equal(applied, appendPersona(plain, profileInstructions(profile)));
  const persona = applied.slice(applied.indexOf("personaPrefix: |"), applied.indexOf("- id: compaction-basic"));
  assert.ok(persona.includes("      - Check twice.\n"), "indented into the block");
  assert.ok(persona.includes("      ## Tool guidance\n      - `exec_command`:"), "tool guidance too");
  assert.equal(renderPatch({ defaultModel: "A", plugins: [], profile: null }), renderPatch({ defaultModel: "A", plugins: [] }), "no profile, no change");
});

test("persona.level rigor is the rigor switch; UNIEAI_PERSONA_RIGOR still decides when set", () => {
  const rigor = { schema_version: 1, model: "M", status: "adopted", persona: { level: "rigor" } };
  const saved = process.env.UNIEAI_PERSONA_RIGOR;
  try {
    delete process.env.UNIEAI_PERSONA_RIGOR;
    assert.ok(renderPatch({ defaultModel: "M", plugins: [], profile: rigor }).includes("not your summary of it"));
    assert.ok(!renderPatch({ defaultModel: "M", plugins: [] }).includes("not your summary of it"), "off without a profile");
    process.env.UNIEAI_PERSONA_RIGOR = "0";
    assert.ok(!renderPatch({ defaultModel: "M", plugins: [], profile: rigor }).includes("not your summary of it"), "0 forces it off");
    process.env.UNIEAI_PERSONA_RIGOR = "1";
    assert.ok(renderPatch({ defaultModel: "M", plugins: [] }).includes("not your summary of it"), "1 turns it on");
  } finally {
    if (saved === undefined) delete process.env.UNIEAI_PERSONA_RIGOR;
    else process.env.UNIEAI_PERSONA_RIGOR = saved;
  }
  assert.equal(personaRigor({ persona: { level: "minimal" } }, {}), false, "levels the pack does not know add nothing");
});

test("plugins: the profile narrows the set, UNIEAI_DSH_PLUGINS still wins", () => {
  const profile = fixture("example.yaml"); // + todo-guard, - web-search, - rewind
  const ids = selectPlugins({}, profile).map((plugin) => plugin.id);
  assert.ok(!ids.includes("unieai-web-search") && !ids.includes("unieai-rewind"));
  assert.ok(ids.includes("unieai-exec") && ids.includes("unieai-todo-guard"));
  assert.equal(pluginEnv({}, profile).UNIEAI_DSH_PLUGINS.split(",").includes("unieai-artifacts"), true, "publish_artifact kept by default");
  assert.deepEqual(selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-rewind" }, profile).map((plugin) => plugin.id), ["unieai-rewind"]);
  assert.deepEqual(selectPlugins({}, fixture("family.yaml")).map((plugin) => plugin.id), ["unieai-exec", "unieai-skills"], "base none");
  assert.deepEqual(selectPlugins({}, fixture("minimal.yaml")), selectPlugins({}), "a profile without plugins keeps the default");
  assert.equal(profilePluginChoice({ schema_version: 1, model: "M", status: "adopted", plugins: { base: "none" } }, { catalog: CATALOG }), "off");
});

test("skills: a layer under user and project skills, over the bundled ones", () => {
  const profile = fixture("example.yaml");
  const out = renderUacConfig({ model: "Example-Model-7B", profile, env: {}, home: "/h", skillsDir: "/layer", artifacts: true });
  assert.ok(out.patch.includes('bundledSkillDir: "/layer"'), "unieai-skills reads the layer as its bundled root");
  assert.ok(!out.patch.includes(BUNDLED_SKILLS_DIR), "in place of the bundled dir");
  assert.deepEqual(Object.keys(out.skillFiles).sort(), ["artifact/SKILL.md", "verify-first/SKILL.md"], "bundled skills kept in the layer");
  const shadow = { ...profile, skills: [{ name: "artifact", description: "profile's own", body: "x" }] };
  const shadowed = renderUacConfig({ model: "M", profile: shadow, env: {}, home: "/h", skillsDir: "/layer", artifacts: true });
  assert.match(shadowed.skillFiles["artifact/SKILL.md"], /profile's own/, "the profile's skill outranks a bundled one");
  const none = renderUacConfig({ model: "M", profile: fixture("minimal.yaml"), env: {}, home: "/h", skillsDir: "/layer", artifacts: true });
  assert.deepEqual(none.skillFiles, {});
  assert.ok(none.patch.includes(`bundledSkillDir: ${JSON.stringify(BUNDLED_SKILLS_DIR)}`), "no skills: the bundled dir as before");
});

test("renderUacConfig: the in-process contract", () => {
  const profile = fixture("example.yaml");
  const out = renderUacConfig({ model: "Example-Model-7B", profile, baseUrl: "https://gw/v1", env: {}, home: "/h" });
  assert.deepEqual(Object.keys(out).sort(), ["patch", "plugins", "profile", "settings", "skillFiles"]);
  assert.deepEqual(out.profile, { model: "Example-Model-7B", status: "candidate", profile_sha: LAB.cases.find((c) => c.file === "example.yaml").profile_sha, source: "explicit", path: null });
  assert.match(out.settings, /model: "Example-Model-7B"/);
  assert.ok(!out.patch.startsWith("- id: acp"), "no ACP route by default (headless reads agent-default-model)");
  assert.ok(!out.plugins.includes("unieai-web-search"));
  assert.ok(!out.patch.includes("bundledSkillDir"), "without skillsDir the profile's skills are not offered");
  assert.throws(() => renderUacConfig({ model: "M", profile: { ...profile, status: "great" }, env: {} }), /invalid profile/);
  const none = renderUacConfig({ model: "M", profile: null, env: {}, home: "/h" });
  assert.equal(none.profile, null);
  assert.equal(none.patch, renderPatch({ defaultModel: "M", plugins: selectPlugins({}), acp: false, home: "/h" }));
});

test("validation: the lab's schema and checks, plus no `{{` in persona text", () => {
  assert.deepEqual(validateProfile(fixture("example.yaml")), []);
  assert.deepEqual(validateProfile({ schema_version: 1, model: "M", status: "adopted", match: ["M-*"] }), []);
  const bad = (patch) => validateProfile({ schema_version: 1, model: "M", status: "adopted", ...patch });
  assert.match(bad({ status: "great" }).join(), /status/);
  assert.match(bad({ extra_key: 1 }).join(), /unexpected property 'extra_key'/);
  assert.match(bad({ schema_version: 2 }).join(), /schema_version/);
  assert.match(bad({ persona: { extra: ["x".repeat(401)] } }).join(), /longer than 400/);
  assert.equal(bad({ persona: { extra: ["語".repeat(400)] } }).length, 0, "lengths count characters, not UTF-16 units");
  assert.match(bad({ skills: [{ name: "Bad Name", description: "d", body: "b" }] }).join(), /does not match/);
  assert.match(bad({ plugins: { enable: ["a"], disable: ["a"] } }).join(), /both enabled and disabled/);
  assert.match(bad({ tool_guidance: [{ tool: "t", text: "a" }, { tool: "t", text: "b" }] }).join(), /duplicate tool/);
  assert.match(bad({ persona: { extra: ["use {{cwd}}"] } }).join(), /prompt variable/);
  assert.match(bad({ match: "M-*" }).join(), /match: expected array/);
});

/** A UnieAI home and a bundled dir holding copies of the fixtures with `status` set. */
function layout(bundled = {}) {
  const root = mkdtempSync(join(tmpdir(), "uac-profiles-"));
  const home = join(root, "home");
  const dir = join(root, "bundled");
  mkdirSync(join(home, "profiles"), { recursive: true });
  mkdirSync(dir);
  for (const [file, { from, status, model, match }] of Object.entries(bundled)) {
    const profile = { ...fixture(from), ...(status ? { status } : {}), ...(model ? { model } : {}), ...(match ? { match } : {}) };
    writeFileSync(join(dir, file), JSON.stringify(profile));
  }
  return { root, home, dir };
}

test("resolution: env, then the user's override, then bundled exact, then bundled match", () => {
  const { root, home, dir } = layout({
    "Family-1.0-Base.yaml": { from: "family.yaml" },
    "Minimal-Model.yaml": { from: "minimal.yaml" },
    "Example-Model-7B.yaml": { from: "example.yaml" }, // candidate: never applied by default
  });
  const warnings = [];
  const resolve = (model, env = {}) => resolveProfile(model, { env, home, bundledDir: dir, warn: (m) => warnings.push(m) })?.identity ?? null;
  try {
    assert.equal(resolve("Minimal-Model").source, "bundled");
    assert.equal(resolve("Family-1.0-Base").source, "bundled");
    assert.equal(resolve("Family-1.5-Chat").model, "Family-1.0-Base", "a family member by match:");
    assert.equal(resolve("Family-1.5-Chat").source, "bundled-match");
    assert.equal(resolve("Other-Model"), null);
    assert.equal(resolve("Example-Model-7B"), null, "a candidate is not applied");

    // The user's override: only adopted ones, else the bundled profile stands.
    copyFileSync(join(FIXTURES, "minimal.yaml"), join(home, "profiles", "Family-1.5-Chat.yaml"));
    assert.equal(resolve("Family-1.5-Chat").source, "user");
    copyFileSync(join(FIXTURES, "example.yaml"), join(home, "profiles", "Minimal-Model.yaml"));
    assert.equal(resolve("Minimal-Model").source, "bundled");
    assert.ok(warnings.some((m) => /is candidate, not adopted/.test(m)));
    writeFileSync(join(home, "profiles", "Family-1.0-Base.yaml"), "schema_version: 1\nmodel: [unclosed");
    assert.equal(resolve("Family-1.0-Base").source, "bundled", "an unreadable override is skipped");

    // UNIEAI_HARNESS_PROFILE: off, or a file applied whatever its status.
    assert.equal(resolve("Minimal-Model", { UNIEAI_HARNESS_PROFILE: "off" }), null);
    const forced = resolve("Anything", { UNIEAI_HARNESS_PROFILE: join(FIXTURES, "example.yaml") });
    assert.deepEqual([forced.source, forced.status], ["env", "candidate"]);
    assert.equal(resolve("Minimal-Model", { UNIEAI_HARNESS_PROFILE: join(root, "missing.yaml") }), null, "a broken forced profile applies none");
    assert.ok(warnings.some((m) => /UNIEAI_HARNESS_PROFILE names an unusable profile/.test(m)));

    // Model ids that cannot name a file skip the override but still match.
    assert.equal(resolve("Family-1.5/../../profiles/Family-1.5-Chat").source, "bundled-match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: the most specific match wins; a tie applies none and is caught by checkBundledProfiles", () => {
  const { root, home, dir } = layout({
    "Fam-Wide.yaml": { from: "family.yaml", model: "Fam-Wide", match: ["Fam-*"] },
    "Fam-Narrow.yaml": { from: "family.yaml", model: "Fam-Narrow", match: ["Fam-2*"] },
  });
  const warnings = [];
  try {
    const resolve = (model) => resolveProfile(model, { env: {}, home, bundledDir: dir, warn: (m) => warnings.push(m) })?.identity?.model ?? null;
    assert.equal(resolve("Fam-2-Chat"), "Fam-Narrow");
    assert.equal(resolve("Fam-1-Chat"), "Fam-Wide");
    assert.deepEqual(checkBundledProfiles(dir), []);
    writeFileSync(join(dir, "Fam-Other.yaml"), JSON.stringify({ ...fixture("family.yaml"), model: "Fam-Other", match: ["Fam-?*"] }));
    assert.equal(resolve("Fam-1-Chat"), null, "Fam-* and Fam-?* claim it equally");
    assert.ok(warnings.some((m) => /equally well/.test(m)));
    assert.ok(checkBundledProfiles(dir).some((m) => /matched equally/.test(m)));
    writeFileSync(join(dir, "wrong-name.yaml"), JSON.stringify(fixture("minimal.yaml")));
    writeFileSync(join(dir, "broken.yaml"), "status: [");
    const problems = checkBundledProfiles(dir);
    assert.ok(problems.some((m) => /name the file Minimal-Model.yaml/.test(m)));
    assert.ok(problems.some((m) => /broken.yaml/.test(m)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundled profiles are valid, unambiguous, and none is tuned content yet", () => {
  assert.deepEqual(checkBundledProfiles(BUNDLED_PROFILES_DIR), []);
  // No profile has been adopted by the lab yet; one lands here with its
  // measurements row (docs/unieai/harness-profiles.md).
  for (const { file, profile } of loadBundledProfiles(BUNDLED_PROFILES_DIR)) {
    if (profile.status === "adopted") assert.ok(profile.measurements?.some((row) => row.verdict === "adopted"), `${file}: adopted without a measurement`);
  }
});

test("profileLogLine names the profile applied", () => {
  assert.equal(profileLogLine(null), "profile: none");
  const identity = renderUacConfig({ model: "M", profile: fixture("minimal.yaml"), env: {}, home: "/h" }).profile;
  assert.equal(profileLogLine(identity), `profile: Minimal-Model adopted sha=${identity.profile_sha} (explicit)`);
});

test("prepareDsh applies the resolved profile: its own patch file, skill layer and identity", () => {
  const home = mkdtempSync(join(tmpdir(), "uac-profiles-home-"));
  writeFileSync(
    join(home, "unieai-self-hosted.json"),
    JSON.stringify({ version: 1, providers: [{ id: "gpu", base_url: "http://gpu-box:8000/v1", models: [{ id: "Example-Model-7B" }] }] }),
  );
  const saved = process.env.UNIEAI_HOME;
  process.env.UNIEAI_HOME = home;
  try {
    const env = { DSH_HOME: join(home, "dsh"), UNIEAI_HARNESS_PROFILE: join(FIXTURES, "example.yaml") };
    const setup = prepareDsh({ env });
    const sha = LAB.cases.find((c) => c.file === "example.yaml").profile_sha;
    assert.deepEqual([setup.profile.model, setup.profile.profile_sha, setup.profile.source], ["Example-Model-7B", sha, "env"]);
    assert.equal(setup.env.UNIEAI_DSH_PATCH, join(home, "dsh", `uac.${sha}.patch.yml`));
    const patch = readFileSync(setup.env.UNIEAI_DSH_PATCH, "utf8");
    assert.ok(patch.includes("- Verify the result against every requirement before finishing."));
    assert.ok(!setup.plugins.includes("unieai-web-search"));
    const layer = join(home, "dsh", "profile-skills", sha);
    assert.ok(patch.includes(`bundledSkillDir: ${JSON.stringify(layer)}`));
    assert.equal(readFileSync(join(layer, "verify-first", "SKILL.md"), "utf8"), LAB.cases.find((c) => c.file === "example.yaml").skill_files["verify-first/SKILL.md"]);
    assert.ok(existsSync(join(layer, "artifact", "SKILL.md")), "the bundled artifact skill stays offered");

    const plain = prepareDsh({ env: { DSH_HOME: join(home, "dsh"), UNIEAI_HARNESS_PROFILE: "off" } });
    assert.equal(plain.profile, null);
    assert.equal(plain.env.UNIEAI_DSH_PATCH, join(home, "dsh", "uac.patch.yml"), "no profile: the patch keeps its name");
    const minimal = prepareDsh({ env: { DSH_HOME: join(home, "dsh") }, mode: "minimal", resolved: null });
    assert.equal(minimal.env.UNIEAI_DSH_PATCH, join(home, "dsh", "uac.minimal.patch.yml"));
  } finally {
    if (saved === undefined) delete process.env.UNIEAI_HOME;
    else process.env.UNIEAI_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
