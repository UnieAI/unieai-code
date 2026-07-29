const { test } = require("node:test")
const assert = require("node:assert/strict")
const { isNewer, parseCliVersion, updateNotice } = require("./versionCompare.cjs")

const BUILD_ID = "0.0.19-dev-uc0.5.0-ac0.4.0"

test("plain semver comparisons work in both directions", () => {
  assert.equal(isNewer("0.0.20", "0.0.19"), true)
  assert.equal(isNewer("0.0.19", "0.0.20"), false)
  assert.equal(isNewer("1.0.0", "0.9.9"), true)
  assert.equal(isNewer("0.0.19", "0.0.19"), false)
})

test("an unstamped build id still compares — otherwise dev builds never see updates", () => {
  assert.equal(isNewer("0.0.20", BUILD_ID), true)
  assert.equal(isNewer("0.0.19", BUILD_ID), false)
  assert.equal(isNewer("0.0.18", BUILD_ID), false)
})

test("a pre-release on the released side never counts as newer", () => {
  assert.equal(isNewer("0.0.20-beta.1", "0.0.19"), null)
  assert.equal(isNewer("0.0.20-beta.1", BUILD_ID), null)
})

test("unreadable input yields null so the caller can stay silent", () => {
  assert.equal(isNewer("not-a-version", "0.0.19"), null)
  assert.equal(isNewer("0.0.20", ""), null)
  assert.equal(isNewer(null, undefined), null)
})

test("a newer cached version produces a notice", () => {
  assert.deepEqual(updateNotice({ latest_version: "0.0.20" }, BUILD_ID), { latest: "0.0.20" })
})

test("no notice when already current", () => {
  assert.equal(updateNotice({ latest_version: "0.0.19" }, BUILD_ID), null)
})

test("a version dismissed in the CLI also quiets the extension", () => {
  const info = { latest_version: "0.0.20", dismissed_version: "0.0.20" }
  assert.equal(updateNotice(info, BUILD_ID), null)
})

test("dismissing an older version does not hide a newer one", () => {
  const info = { latest_version: "0.0.21", dismissed_version: "0.0.20" }
  assert.deepEqual(updateNotice(info, BUILD_ID), { latest: "0.0.21" })
})

test("a missing or empty cache produces no notice", () => {
  assert.equal(updateNotice(null, BUILD_ID), null)
  assert.equal(updateNotice({}, BUILD_ID), null)
})

test("the CLI version is extracted from surrounding text", () => {
  assert.equal(parseCliVersion("unieai 0.0.19-dev-uc0.5.0-ac0.4.0"), BUILD_ID)
  assert.equal(parseCliVersion("0.0.20\n"), "0.0.20")
  assert.equal(parseCliVersion("no version here"), null)
  assert.equal(parseCliVersion(null), null)
})
