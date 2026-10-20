// Copyright (c) 2026 UnieAI. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";

import { billingFailureOf, billingMessage, describeTurnError, formatResetTime, isBillingFailure } from "./unieai-billing.mjs";

const now = new Date(2026, 9, 20, 12, 0, 0);
const at = (hours) => new Date(now.getTime() + hours * 3600_000).toISOString();

test("finds the billing code in the HTTP failure text dsh reports", () => {
  const body = JSON.stringify({ error: { code: "plan_limit_reached", window: "fiveHour", resetsAt: at(3) } });
  assert.deepEqual(billingFailureOf(`429 ${body}`), { code: "plan_limit_reached", window: "fiveHour", resetsAt: at(3), periodEnd: null });
  // Wrapped by dsh's "Internal error: <details>", details nested under data.
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
