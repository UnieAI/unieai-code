/**
 * agentCoreBackend.ts — drive the unieai-agent-core loop in-process and map
 * its callbacks onto the same webview protocol the app-server backend posts.
 *
 * This is the second engine (dual-engine): the panel can run either the codex
 * Rust app-server or this embedded JS loop. Both feed the identical webview,
 * so all the rendering work (diff/plan/subagent/approvals) is reused.
 *
 * agent-core is ESM; esbuild bundles it into the extension at build time.
 */
// @ts-expect-error — JS ESM from the agent-runtime package (bundled by esbuild)
import { createEngine } from "../../../agent-runtime/src/engine.mjs"
// @ts-expect-error — JS ESM from the agent-runtime package (bundled by esbuild)
import { liveProcessManagers } from "../../../agent-runtime/src/process-manager.mjs"
import type { ProcessSnapshot } from "./backgroundProcesses.cjs"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

/** The half of a process manager the host UI uses. */
type ProcessManager = {
  list: () => ProcessSnapshot[]
  status: (id: string) => ProcessSnapshot | null
  stop: (id: string) => Promise<{ ok: boolean; forced?: boolean; error?: string }>
  stopAll: () => Promise<unknown[]>
}

function managers(): ProcessManager[] {
  return liveProcessManagers() as ProcessManager[]
}

/**
 * Every background process alive in this extension host.
 *
 * The manager is created inside a toolset closure and neither the toolset nor
 * the engine hands it back, so process-manager.mjs keeps a registry of itself
 * and this reads it. Host-wide rather than per-backend on purpose: a dev server
 * started before "New Chat" is still holding its port, and scoping the list to
 * the current engine would leave the user with no way left to see or stop it.
 */
export function listBackgroundProcesses(): ProcessSnapshot[] {
  return managers().flatMap((m) => m.list())
}

/**
 * Stop one process wherever it lives.
 *
 * Ids are unique only within the manager that issued them (`bg_1` exists in
 * every one), so each manager is asked whether it owns this id rather than
 * assuming a single global table.
 */
export async function stopBackgroundProcess(id: string): Promise<boolean> {
  const owners = managers().filter((m) => m.status(id))
  if (owners.length === 0) {
    return false
  }
  const results = await Promise.all(owners.map((m) => m.stop(id)))
  return results.every((r) => r.ok)
}

/** Stop everything still running, across every engine. Returns how many. */
export async function stopAllBackgroundProcesses(): Promise<number> {
  const results = await Promise.all(managers().map((m) => m.stopAll()))
  return results.reduce((total, r) => total + r.length, 0)
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"

export interface AgentCoreCallbacks {
  post: (message: Json) => void
  /** Ask the host UI for a decision; resolves with the user's choice. */
  requestApproval: (detail: { tool: string; action: string; detail: string }) => Promise<ApprovalDecision>
  /** Put a multiple-choice question to the user; resolves with the chosen label, or null if dismissed. */
  requestQuestion: (detail: { question: string; options: string[] }) => Promise<string | null>
  /** Localized wrapper for the goal-mode closing summary meta line. */
  formatSummary: (text: string) => string
  /** Localized wrapper for the background-review findings meta line. */
  formatReview: (finding: string) => string
}

/** One panel conversation backed by the agent-core loop. */
export class AgentCoreBackend {
  private engine: ReturnType<typeof createEngine> | null = null
  private abort: AbortController | null = null
  // Agent text is emitted in blocks, one per run of text between tool calls.
  // The webview keys items by id and replaces a repeated id in place, so a
  // single id for the whole turn would render the closing answer up where the
  // turn's first words appeared -- above every tool card that followed.
  private blockIndex = 0
  private blockText = ""
  // Whether the current engine was built with the fetch tool enabled. A change
  // to the toggle between turns has to rebuild the engine, because the toolset
  // is assembled once when the engine is created.
  private webAccess = false
  // Command line shown on a tool card, cached from the started event: the
  // completed/failed event carries no args_preview, and rebuilding the card
  // from it alone would degrade "$ git status" to "$ bash".
  private toolCommands = new Map<string, string>()

  private get agentItemId(): string {
    return `agent-${this.blockIndex}`
  }

  /** Close the current text block and open the next one. */
  private flushTextBlock(): void {
    if (this.blockText.trim()) {
      this.cb.post({
        type: "itemUpsert",
        item: { id: this.agentItemId, type: "agent_message", text: this.blockText },
        done: true,
      })
    }
    this.blockText = ""
    this.blockIndex += 1
  }

  constructor(
    private readonly workspace: string,
    private readonly cb: AgentCoreCallbacks,
  ) {}

  get model(): string {
    return this.engine?.model ?? ""
  }

  get sessionId(): string {
    return this.engine?.sessionId ?? ""
  }

  get models(): Array<{ id: string; name?: string }> {
    return this.engine?.models ?? []
  }

  /** (Re)create the engine for a model / resumed session. */
  private ensureEngine(model?: string, resume?: string): void {
    // Keep the live engine (and with it the whole conversation history) unless
    // the caller is resuming another session or actually CHANGING the model.
    // The webview sends the current model on every send, so treating any
    // truthy model as "rebuild" would discard the session each turn.
    if (this.engine && !resume && (!model || model === this.engine.model)) {
      return
    }
    this.engine = createEngine({
      workspace: this.workspace,
      model,
      resume: resume ?? null,
      webAccess: this.webAccess,
      // Carried into every rebuilt engine so switching model or starting a new
      // chat does not quietly drop a vision model the user already verified.
      visionModel: this.visionModelValue,
      subagents: this.subagentsValue,
      onText: (d: string) => {
        this.blockText += d
        this.cb.post({ type: "turnDelta", kind: "agent", itemKey: this.agentItemId, text: d })
      },
      onReasoning: (d: string) =>
        this.cb.post({
          type: "turnDelta",
          kind: "reasoning",
          itemKey: `reasoning-${this.blockIndex}`,
          text: d,
        }),
      onToolEvent: (e: Json) => this.mapToolEvent(e),
      onSummary: (text: string) => {
        // Closing summary from the goal-mode summarizer — surface as a meta
        // line under the transcript.
        this.cb.post({ type: "stderr", text: this.cb.formatSummary(text) })
      },
      onReview: (finding: string) => {
        // Background verifier (goal mode "review") found gaps AFTER the turn
        // ended. Advisory: the user replies "continue" to have them addressed.
        this.cb.post({ type: "stderr", text: this.cb.formatReview(finding) })
      },
      onPlan: (plan: { steps: Array<{ text: string; done: boolean }> }) => {
        // Goal-mode planner checklist → render via the panel's plan card
        // (checkbox-markdown text, same shape the plan delta path parses).
        const md = (plan?.steps ?? []).map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n")
        if (md) this.cb.post({ type: "turnDelta", kind: "plan", itemKey: "goal-plan", text: md })
      },
      requestApproval: async ({ tool, action, detail }: Json) => {
        return this.cb.requestApproval({ tool, action, detail })
      },
      requestQuestion: async ({ question, options }: Json) => {
        return this.cb.requestQuestion({ question, options })
      },
    })
  }

  private mapToolEvent(e: Json): void {
    // The `task` tool runs a sub-agent loop whose own tool events bubble up
    // here tagged {taskId, depth}. Give the delegation itself a card so the
    // user can see what was handed off and when it came back.
    const taskId = e.taskId ? String(e.taskId) : ""
    if (e.type === "task_start") {
      this.flushTextBlock()
      const description = String(e.description ?? "subtask")
      this.toolCommands.set(taskId, `task ${description}`)
      this.cb.post({
        type: "itemUpsert",
        item: {
          id: taskId,
          type: "command_execution",
          tool_name: "task",
          command: `task ${description}`,
          aggregated_output: "",
          status: "in_progress",
        },
        done: false,
      })
      return
    }
    if (e.type === "task_end") {
      const state = String(e.state ?? "completed")
      this.cb.post({
        type: "itemUpsert",
        item: {
          id: taskId,
          type: "command_execution",
          tool_name: "task",
          command: this.toolCommands.get(taskId) ?? "task",
          aggregated_output: state === "completed" ? "" : `sub-agent ${state}`,
          status: state === "completed" ? "completed" : "failed",
        },
        done: true,
      })
      this.toolCommands.delete(taskId)
      return
    }

    // agent-core tool events → webview itemUpsert. Tool ids aren't stable
    // per-item the way app-server's are, so use the event's own id. Sub-agent
    // ids are namespaced: two sub-agents running in parallel would otherwise
    // overwrite each other's cards, and the parent's too.
    const rawId = e.tool_use_id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const id = taskId ? `${taskId}:${rawId}` : rawId
    const tool = String(e.tool_name ?? "tool")
    // agent-core does not forward tool args on the event (loop.mjs emits only
    // {tool_use_id, tool_name}), so `args_preview` is usually empty. We still
    // carry `tool_name` + `status` so the webview can pick a per-tool card
    // shape (bash vs read/edit/write vs generic) and colour failures.
    if (e.type === "tool_use_started") {
      // Settle the text that led up to this call before the tool card lands,
      // so anything the model says afterwards starts a block below it.
      this.flushTextBlock()
      const argsPreview = e.args_preview ? String(e.args_preview) : ""
      // For bash the args preview IS the command line, so don't prefix "bash".
      // For file/other tools show "<tool> <arg>" (e.g. "read src/foo.ts").
      const label = tool === "bash" ? argsPreview || tool : `${tool} ${argsPreview}`.trim()
      // Mark sub-agent work so it does not read as something the main thread did.
      const command = taskId ? `↳ ${label}` : label
      this.toolCommands.set(String(id), command)
      this.cb.post({
        type: "itemUpsert",
        item: {
          id,
          type: "command_execution",
          tool_name: tool,
          command,
          aggregated_output: "",
          status: "in_progress",
        },
        done: false,
      })
    } else if (e.type === "file_diff") {
      // The loop emits a tool's metadata.timelineEvent INSTEAD OF the generic
      // tool_use_completed (Studio's sql_call frames rely on that), so this IS
      // the completion signal for a successful edit/write. Render the
      // red/green file card (same shape as app-server file_change items).
      this.toolCommands.delete(String(id))
      const changes =
        e.path && typeof e.diff === "string"
          ? [{ path: String(e.path), kind: String(e.kind ?? "update"), diff: e.diff }]
          : []
      this.cb.post({
        type: "itemUpsert",
        item: { id, type: "file_change", status: "completed", changes },
        done: true,
      })
    } else if (e.type === "file_read") {
      // Same replacement semantics: this IS the read's completion. Settle the
      // card with the line-count badge.
      let command = this.toolCommands.get(String(id)) ?? tool
      this.toolCommands.delete(String(id))
      if (Number.isFinite(e.lines)) command = `${command} · ${Number(e.lines)}L`
      this.cb.post({
        type: "itemUpsert",
        item: { id, type: "command_execution", tool_name: tool, command, aggregated_output: "", status: "completed" },
        done: true,
      })
    } else if (e.type === "process_start") {
      // Same replacement semantics as file_diff/file_read: this event arrives
      // INSTEAD OF tool_use_completed, so it is the only chance to settle the
      // run_background card — left alone it would spin in_progress forever.
      //
      // Settled as "completed" the moment the spawn succeeds, even though the
      // job is still running, because there is no matching end event to close
      // it with. A background job's liveness belongs to the status bar, which
      // polls; this card is the permanent record that it was STARTED.
      this.toolCommands.delete(String(id))
      const started = String(e.id ?? "")
      const command = e.command ? `${tool} ${String(e.command)}` : tool
      this.cb.post({
        type: "itemUpsert",
        item: {
          id,
          type: "command_execution",
          tool_name: tool,
          command,
          aggregated_output: `${started} is running in the background — see the status bar to read or stop it.`,
          status: "completed",
        },
        done: true,
      })
    } else if (e.type === "tool_use_completed" || e.type === "tool_use_failed") {
      const failed = e.type === "tool_use_failed"
      const output = String(e.output_preview ?? e.result ?? e.error ?? "")
      const command = this.toolCommands.get(String(id)) ?? tool
      this.toolCommands.delete(String(id))
      this.cb.post({
        type: "itemUpsert",
        item: {
          id,
          type: "command_execution",
          tool_name: tool,
          command,
          aggregated_output: output,
          status: failed ? "failed" : "completed",
        },
        done: true,
      })
    }
  }

  models_ready(): boolean {
    return (this.engine?.models.length ?? 0) > 0
  }

  newChat(model?: string): void {
    this.engine = null
    this.ensureEngine(model)
  }

  resume(sessionId: string): void {
    this.engine = null
    this.ensureEngine(undefined, sessionId)
  }

  /** Read-only rewind points: checkpoints + files changed since the previous one. */
  describeCheckpoints(): Array<{ index: number; at: number | null; messageIndex: number; files: Array<{ path: string; status: string }> }> {
    return this.engine?.describeCheckpoints() ?? []
  }

  /** Preview what a rewind to checkpoint `index` would change (read-only). */
  previewRewind(index: number): Promise<{ index: number; files: Array<{ path: string; status: string }> } | null> {
    return this.engine?.previewRewind(index) ?? Promise.resolve(null)
  }

  /** Apply a user-confirmed rewind; the pre-restore state becomes an undo point. */
  applyRewind(index: number): Promise<{ index: number; restored: string[]; deleted: string[] } | null> {
    return this.engine?.applyRewind(index) ?? Promise.resolve(null)
  }

  /** Set goal mode on the live engine: false | "review" (background) | "gate" (blocking). */
  setGoalMode(value: false | "review" | "gate"): void {
    this.goalMode = value
    this.engine?.setGoalMode(value)
  }
  private goalMode: false | "review" | "gate" = false

  /** Model that reads images on the main model's behalf (null = images unavailable). */
  get visionModel(): string | null {
    return this.visionModelValue
  }

  setVisionModel(model: string | null): void {
    this.visionModelValue = model
    // Held here as well as on the engine: a new chat rebuilds the engine, and
    // the choice must survive that rather than silently reverting.
    this.engine?.setVisionModel(model)
  }
  private visionModelValue: string | null = null

  /** Whether the model may delegate subtasks to a sub-agent (`task` tool). */
  setSubagents(enabled: boolean): void {
    this.subagentsValue = enabled
    // Same reason as visionModel: a new chat rebuilds the engine, so the
    // setting has to live here too or it reverts behind the user's back.
    this.engine?.setSubagents(enabled)
  }
  private subagentsValue = false

  /**
   * Ask the gateway whether `model` can really see an image.
   *
   * Needs a live engine for its credentials; without one the caller is told so
   * rather than shown a probe failure that looks like the model's fault.
   */
  async probeVision(model: string): Promise<Json> {
    this.ensureEngine()
    if (!this.engine) {
      return { result: "error", model, detail: "not signed in" }
    }
    return this.engine.probeVision(model)
  }

  async send(text: string, model?: string, webAccess = false): Promise<void> {
    this.webAccess = webAccess
    this.ensureEngine(model)
    this.engine?.setGoalMode(this.goalMode)
    // Apply the toggle without discarding the session: the engine rebuilds only
    // its toolset next turn. (ensureEngine already used this.webAccess for a
    // brand-new engine; this covers a flip on an existing one.)
    this.engine?.setWebAccess(webAccess)
    this.abort = new AbortController()
    // The webview scopes item keys by turn, so blocks restart at 0 each send.
    this.blockIndex = 0
    this.blockText = ""
    this.cb.post({ type: "running", value: true })
    try {
      const result = await this.engine!.send(text, { abortSignal: this.abort.signal })
      // Replace the plain streamed text with a markdown-rendered final item,
      // matching the app-server backend's item.completed behaviour.
      this.flushTextBlock()
      this.cb.post({ type: "turnState", state: result.finishReason === "failed" ? "failed" : "idle", retryable: result.finishReason === "failed" })
    } catch (err) {
      // Settle whatever was streamed before the failure or interrupt, so the
      // partial answer renders as markdown instead of a stranded raw stream.
      this.flushTextBlock()
      this.cb.post({ type: "turnState", state: "failed", retryable: true })
      this.cb.post({ type: "stderr", text: String((err as Error)?.message ?? err) })
    } finally {
      this.cb.post({ type: "running", value: false })
      this.abort = null
    }
  }

  interrupt(): void {
    this.abort?.abort()
    this.cb.post({ type: "turnState", state: "interrupted" })
    this.cb.post({ type: "running", value: false })
  }

  /** Whether a turn is currently in flight for this conversation. */
  isBusy(): boolean {
    return this.engine?.isBusy() ?? false
  }

  /**
   * Fold a mid-turn interjection into the RUNNING turn (the loop drains it
   * between steps). Does NOT start a new turn. Returns true if a turn was in
   * flight to receive it; false if there is no engine / no turn running (in
   * which case the caller should fall back to a normal `send`).
   */
  steer(text: string): boolean {
    const t = text.trim()
    if (!t) {
      return false
    }
    return this.engine?.steer(t) ?? false
  }
}
