// Copyright (c) 2026 UnieAI. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authMessage,
  billingFailureOf,
  billingMessage,
  describeTurnError,
  formatResetTime,
  isAuthFailure,
  isBillingFailure,
} from "./unieai-billing.mjs";

const now = new Date(2026, 9, 20, 12, 0, 0);
const at = (hours) => new Date(now.getTime() + hours * 3600_000).toISOString();

test("finds the billing code in the HTTP failure text rabi reports", () => {
  const body = JSON.stringify({ error: { code: "plan_limit_reached", window: "fiveHour", resetsAt: at(3) } });
  assert.deepEqual(billingFailureOf(`429 ${body}`), { code: "plan_limit_reached", window: "fiveHour", resetsAt: at(3), periodEnd: null });
  // Wrapped by rabi's "Internal error: <details>", details nested under data.
  const wrapped = `Internal error: ${JSON.stringify({ status: 402, body: JSON.stringify({ error: { code: "wallet_monthly_limit_reached", details: { periodEnd: at(48) } } }) })}`;
  assert.deepEqual(billingFailureOf(wrapped), { code: "wallet_monthly_limit_reached", window: null, resetsAt: null, periodEnd: at(48) });
  // Text with no JSON still names the code.
  assert.equal(billingFailureOf("402 Payment Required: insufficient_balance").code, "insufficient_balance");
  assert.equal(billingFailureOf("429 Too Many Requests: rate limit exceeded"), null);
  assert.equal(isBillingFailure(undefined), false);
});

test("the messages match the codex engine's", () => {
  const studioUrl = "https://studio.corp.example/";
  assert.equal(
    billingMessage({ code: "plan_limit_reached", window: "fiveHour", resetsAt: at(3) }, { studioUrl, now }),
    `You've reached your 5-hour plan limit. It resets at ${formatResetTime(at(3), now)}. Turn on extra usage in /usage to keep going on API credits.`,
  );
  assert.equal(
    billingMessage({ code: "plan_limit_reached", window: null, resetsAt: null }, { studioUrl, now }),
    "You've reached your plan limit. Turn on extra usage in /usage to keep going on API credits.",
  );
  assert.equal(
    billingMessage({ code: "insufficient_balance" }, { studioUrl, now }),
    "Your UnieAI wallet is out of credits. Top up at https://studio.corp.example/plan to continue.",
  );
  assert.equal(
    billingMessage({ code: "wallet_monthly_limit_reached", periodEnd: null }, { studioUrl: "", now }),
    "You've reached your monthly wallet spending limit. Raise it at https://studio.unieai.com/plan.",
  );
});

test("reset times read as a clock today and a date otherwise", () => {
  assert.match(formatResetTime(at(3), now), /^\d{1,2}:\d{2}\s?[AP]M$/);
  assert.match(formatResetTime(at(72), now), /^Oct 23, \d{1,2}:\d{2}\s?[AP]M$/);
  assert.equal(formatResetTime("not a date", now), null);
});

test("a turn error is described as a usage limit only for billing refusals", () => {
  const billed = describeTurnError(`402 {"error":{"code":"insufficient_balance"}}`, { studioUrl: "https://s.example", now });
  assert.deepEqual(billed, {
    message: "Your UnieAI wallet is out of credits. Top up at https://s.example/plan to continue.",
    codexErrorInfo: "usageLimitExceeded",
  });
  assert.deepEqual(describeTurnError("boom", { studioUrl: "https://s.example" }), { message: "boom", codexErrorInfo: null });
});

test("a rejected key is recognized the way rabi reports it", () => {
  // Exactly what the TUI showed: rabi's wrapper, the status, the gateway's code.
  assert.equal(isAuthFailure('Internal error: turn failed: 401 "invalid_api_key"'), true);
  assert.equal(isAuthFailure('401 {"error":"invalid_api_key","status":401}'), true);
  assert.equal(isAuthFailure("401 Unauthorized"), true);
  assert.equal(isAuthFailure("authentication_error"), true);
  // A billing refusal and an unrelated 401 stay out of it.
  assert.equal(isAuthFailure('402 {"error":{"code":"insufficient_balance"}}'), false);
  assert.equal(isAuthFailure("model call failed (HTTP 400): bad grammar"), false);
  assert.equal(isAuthFailure(undefined), false);
});

test("the rejected-key message names the gateway and the login that fixes it", () => {
  const studioUrl = "https://studio.corp.example/";
  // Studio key against Rabi's gateway: the mix-up a `login --rabi` resolves.
  assert.match(
    authMessage({ baseUrl: "https://rabi.unieai.com/api/desktop/v1", account: "studio", studioUrl }),
    /is Rabi's, and this machine is signed in to UnieAI Studio[\s\S]*unieai login --rabi/,
  );
  // Rabi key against Rabi's gateway: the key itself is stale.
  assert.match(
    authMessage({ baseUrl: "https://rabi.unieai.com/api/desktop/v1", account: "rabi", studioUrl }),
    /Rabi's gateway at https:\/\/rabi\.unieai\.com\/api\/desktop\/v1 rejected[\s\S]*unieai login --rabi/,
  );
  // The usual case: the gateway key moved on and this machine kept the old one.
  const studio = authMessage({ baseUrl: "https://api.unieai.com/v1/", account: "studio", studioUrl });
  assert.match(studio, /The UnieAI gateway at https:\/\/api\.unieai\.com\/v1 rejected/);
  assert.match(studio, /unieai login sync/);
  assert.match(studio, /https:\/\/studio\.corp\.example\/settings/);
  // No stored gateway still reads as a sentence.
  assert.match(authMessage({ baseUrl: "", account: "studio" }), /^The UnieAI gateway rejected/);
});

test("a turn error explains a rejected key and keeps rabi's own words", () => {
  const raw = 'Internal error: turn failed: 401 "invalid_api_key"';
  const described = describeTurnError(raw, {
    studioUrl: "https://s.example",
    credentials: { gatewayBaseUrl: "https://api.unieai.com/v1", accountId: "studio|https://api.unieai.com/v1|u@example.com" },
  });
  assert.equal(described.codexErrorInfo, null, "a rejected key is not a usage limit");
  assert.match(described.message, /^The UnieAI gateway at https:\/\/api\.unieai\.com\/v1 rejected/);
  assert.ok(described.message.endsWith(raw), "the original failure stays for a report");
});
