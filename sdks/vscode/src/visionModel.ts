import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"

/**
 * Picking and verifying the delegated vision model.
 *
 * The gateway catalog only carries `{id, name}` — nothing says which models
 * accept images — so the user picks one and we CHECK it by sending a small
 * image whose answer we already know. A gateway that accepts the image, drops
 * it, and lets the model confabulate would otherwise look like success.
 */

const STATE_FILENAME = "vision.json"

export type ProbeOutcome = {
  result: "ok" | "refused" | "wrong" | "error"
  model?: string
  expected?: string
  answer?: string
  detail?: string
}

export type VisionState = { model: string | null }

export type VisionHost = {
  /** Models the user is signed in to, as stored by `unieai login`. */
  models: () => Array<{ id: string; name?: string }>
  /** Runs the real probe against the gateway. */
  probe: (model: string) => Promise<ProbeOutcome>
  /** Directory holding vision.json. */
  home: string
}

/** Read the persisted choice, tolerating absence and corruption. */
export function readVisionState(home: string): VisionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, STATE_FILENAME), "utf8")) as {
      model?: unknown
    }
    return { model: typeof parsed?.model === "string" ? parsed.model : null }
  } catch {
    return { model: null }
  }
}

/**
 * Persist the choice, preserving any probe history the CLI wrote.
 *
 * Both surfaces share this file, so a blind overwrite here would throw away the
 * CLI's cached probe results and force every model to be re-tested.
 */
export function writeVisionModel(home: string, model: string | null): void {
  const file = path.join(home, STATE_FILENAME)
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    existing = {}
  }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, model }, null, 2)}\n`, "utf8")
}

/** Turn a probe outcome into the message the user sees. */
export function describeOutcome(outcome: ProbeOutcome): { ok: boolean; message: string } {
  const model = outcome.model ?? "the model"
  switch (outcome.result) {
    case "ok":
      return { ok: true, message: `${model} can read images — verified.` }
    case "refused":
      return { ok: false, message: `${model} rejected the image: ${outcome.detail ?? "no detail"}` }
    case "wrong":
      // Naming both sides matters: the request SUCCEEDED here, so without the
      // mismatch spelled out this failure reads like it worked.
      return {
        ok: false,
        message: `${model} did not actually see the image (expected "${outcome.expected}", got "${outcome.answer}"). It is probably text-only.`,
      }
    default:
      return { ok: false, message: `Could not test ${model}: ${outcome.detail ?? "unknown error"}` }
  }
}

/**
 * Run the pick-and-verify flow.
 *
 * Returns the model that was accepted, or null if the user cancelled or the
 * chosen model failed verification. A failed probe deliberately does NOT save:
 * remembering a model that cannot see would just move the failure to later,
 * when the user is mid-task and less able to diagnose it.
 */
export async function selectVisionModel(host: VisionHost): Promise<string | null> {
  const models = host.models()
  if (!models.length) {
    void vscode.window.showWarningMessage("Sign in to UnieAI Code first — no models are available.")
    return null
  }

  const current = readVisionState(host.home).model
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.name ?? m.id,
      description: m.id === current ? "current vision model" : m.id,
      id: m.id,
    })),
    {
      title: "Vision model",
      placeHolder: "Pick the model that will read images for you — it will be tested",
    },
  )
  if (!picked) {
    return null
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Testing ${picked.id} with a sample image…` },
    () => host.probe(picked.id),
  )

  const described = describeOutcome(outcome)
  if (!described.ok) {
    void vscode.window.showErrorMessage(described.message)
    return null
  }

  writeVisionModel(host.home, picked.id)
  void vscode.window.showInformationMessage(described.message)
  return picked.id
}
