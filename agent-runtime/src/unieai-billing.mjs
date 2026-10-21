// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-billing.mjs — the UnieAI gateway's billing refusals, for uac.
 *
 * The gateway refuses a request it cannot bill with a typed error
 * (docs/unieai/usage-api.md):
 *   - 429 `plan_limit_reached` (`window`, `resetsAt`): a plan window is used
 *     up and extra usage is off;
 *   - 402 `insufficient_balance`: the wallet is empty;
 *   - 402 `wallet_monthly_limit_reached`: the month's wallet ceiling is hit.
 *
 * dsh only sees an HTTP failure with the body in its text: it would retry the
 * 429 like any rate limit and show the raw JSON. unieai-control stops the
 * retries (`isBillingFailure`), and the app-server turns the failure into the
 * same message the codex engine shows (codex-rs protocol `UnieAIBillingError`).
 */
import { loadCredentials } from "./config.mjs";

export const BILLING_CODES = Object.freeze(["plan_limit_reached", "insufficient_balance", "wallet_monthly_limit_reached"]);

const DEFAULT_STUDIO_URL = "https://studio.unieai.com";

/** Every `{...}` in `text` that parses as JSON, outermost first. */
function jsonObjectsIn(text) {
  const found = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      try {
        found.push(JSON.parse(text.slice(start, end + 1)));
        return found;
      } catch {
        // try a shorter span
      }
    }
  }
  return found;
}

/** The `error` object carrying a billing code, searched through nested JSON. */
function billingErrorIn(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  if (BILLING_CODES.includes(value.code)) return value;
  for (const child of Object.values(value)) {
    const found = billingErrorIn(typeof child === "string" ? jsonObjectsIn(child)[0] : child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The billing refusal in a failure's text, or null.
 * @param {string} text - an error message (dsh's carries the HTTP body).
 * @returns {{code: string, window: string|null, resetsAt: string|null, periodEnd: string|null}|null}
 */
export function billingFailureOf(text) {
  const message = String(text ?? "");
  if (!BILLING_CODES.some((code) => message.includes(code))) return null;
  const error = jsonObjectsIn(message).map((value) => billingErrorIn(value)).find(Boolean);
  const field = (name) => error?.[name] ?? error?.details?.[name] ?? null;
  const code = error?.code ?? BILLING_CODES.find((candidate) => message.includes(candidate));
  return { code, window: field("window"), resetsAt: field("resetsAt"), periodEnd: field("periodEnd") };
}

export function isBillingFailure(text) {
  return billingFailureOf(text) !== null;
}

/** "3:00 PM" today, "Oct 26, 3:00 PM" another day, in local time. */
export function formatResetTime(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

function studioUrlOrDefault(studioUrl) {
  const url = String(studioUrl ?? "").trim().replace(/\/+$/, "");
  return url || DEFAULT_STUDIO_URL;
}

/** What to tell the user about a billing refusal. */
export function billingMessage(failure, { studioUrl, now = new Date() } = {}) {
  const planUrl = `${studioUrlOrDefault(studioUrl)}/plan`;
  switch (failure.code) {
    case "plan_limit_reached": {
      const label = { fiveHour: "5-hour", five_hour: "5-hour", week: "weekly", weekly: "weekly" }[failure.window];
      const limit = label ? `${label} plan limit` : "plan limit";
      const when = failure.resetsAt ? formatResetTime(failure.resetsAt, now) : null;
      const resets = when ? ` It resets at ${when}.` : "";
      return `You've reached your ${limit}.${resets} Turn on extra usage in /usage to keep going on API credits.`;
    }
    case "insufficient_balance":
      return `Your UnieAI wallet is out of credits. Top up at ${planUrl} to continue.`;
    case "wallet_monthly_limit_reached": {
      const when = failure.periodEnd ? formatResetTime(failure.periodEnd, now) : null;
      const wait = when ? `, or wait until it resets at ${when}` : "";
      return `You've reached your monthly wallet spending limit. Raise it at ${planUrl}${wait}.`;
    }
    default:
      return null;
  }
}

/**
 * A turn failure as the client should see it: the billing message (and the
 * protocol's `usageLimitExceeded`) for a billing refusal, else as it was.
 * @returns {{message: string, codexErrorInfo: string|null}}
 */
export function describeTurnError(message, { studioUrl = undefined, now = new Date() } = {}) {
  const text = String(message ?? "");
  const failure = billingFailureOf(text);
  if (!failure) return { message: text, codexErrorInfo: null };
  const url = studioUrl === undefined ? loadCredentials().studioUrl : studioUrl;
  return { message: billingMessage(failure, { studioUrl: url, now }) ?? text, codexErrorInfo: "usageLimitExceeded" };
}
