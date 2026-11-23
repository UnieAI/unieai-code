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
 * rabi only sees an HTTP failure with the body in its text: it would retry the
 * 429 like any rate limit and show the raw JSON. unieai-control stops the
 * retries (`isBillingFailure`), and the app-server turns the failure into the
 * same message the codex engine shows (codex-rs protocol `UnieAIBillingError`).
 *
 * The gateway also refuses a key it does not accept (401 `invalid_api_key`),
 * which rabi passes on as a bare status and a code; `isAuthFailure` recognizes
 * it so the app-server can name the gateway and the login that fixes it.
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
 * @param {string} text - an error message (rabi's carries the HTTP body).
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

/** The gateway's ways of saying the key it was given is not one it accepts. */
export const AUTH_CODES = Object.freeze(["invalid_api_key", "invalid_token", "authentication_error"]);

/**
 * Whether a failure is the gateway refusing this machine's key.
 *
 * rabi shows the refusal as `Internal error: turn failed: 401 "invalid_api_key"`,
 * which says nothing about which gateway, whose key, or what to do next.
 * @param {string} text - an error message
 */
export function isAuthFailure(text) {
  const message = String(text ?? "");
  if (AUTH_CODES.some((code) => message.includes(code))) return true;
  return /\b401\b/.test(message) && /unauthorized|api[_ ]?key|token/i.test(message);
}

/** Rabi's own gateway, which accepts only a Rabi desktop key. */
function isRabiGateway(baseUrl) {
  return /\/api\/desktop(\/|$)/.test(String(baseUrl ?? ""));
}

/**
 * What to tell the user about a rejected key: which gateway refused it, which
 * account this machine is on, and the command that signs in again.
 */
export function authMessage({ baseUrl, account, studioUrl, code = "invalid_api_key" } = {}) {
  const gateway = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const at = gateway ? ` at ${gateway}` : "";
  const studio = studioUrlOrDefault(studioUrl);
  if (isRabiGateway(gateway) && String(account ?? "studio") === "studio") {
    return (
      `The gateway${at} is Rabi's, and this machine is signed in to UnieAI Studio, whose key Rabi does not accept (401 ${code}). ` +
      "Run `unieai login --rabi` to sign in to Rabi, or `unieai login` to sign in to Studio again."
    );
  }
  if (isRabiGateway(gateway)) {
    return (
      `Rabi's gateway${at} rejected this machine's key (401 ${code}). ` +
      "The key may have been replaced or revoked: run `unieai login --rabi` to sign in to Rabi again."
    );
  }
  return (
    `The UnieAI gateway${at} rejected this machine's key (401 ${code}), so no model call can run. ` +
    "The key may have expired or been replaced by a newer sign-in elsewhere: run `unieai login sync` to fetch the current gateway key, " +
    `or \`unieai logout\` then \`unieai login\`. \`unieai login status\` shows the account and gateway this machine uses (manage the key at ${studio}/settings).`
  );
}

/**
 * A turn failure as the client should see it: the billing message (and the
 * protocol's `usageLimitExceeded`) for a billing refusal, what to do about a
 * rejected key, else as it was.
 * @returns {{message: string, codexErrorInfo: string|null}}
 */
export function describeTurnError(message, { studioUrl = undefined, now = new Date(), credentials = undefined } = {}) {
  const text = String(message ?? "");
  const failure = billingFailureOf(text);
  if (failure) {
    const url = studioUrl === undefined ? loadCredentials().studioUrl : studioUrl;
    return { message: billingMessage(failure, { studioUrl: url, now }) ?? text, codexErrorInfo: "usageLimitExceeded" };
  }
  if (isAuthFailure(text)) {
    const signedIn = credentials ?? loadCredentials();
    const url = studioUrl === undefined ? signedIn.studioUrl : studioUrl;
    const account = String(signedIn.accountId ?? "").split("|")[0] || "studio";
    const code = AUTH_CODES.find((candidate) => text.includes(candidate)) ?? "invalid_api_key";
    const auth = authMessage({ baseUrl: signedIn.gatewayBaseUrl, account, studioUrl: url, code });
    // Keep rabi's own words: they carry the endpoint a report should name.
    return { message: `${auth}\n\n${text}`, codexErrorInfo: null };
  }
  return { message: text, codexErrorInfo: null };
}
