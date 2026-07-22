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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"

export interface AgentCoreCallbacks {
  post: (message: Json) => void
  /** Ask the host UI for a decision; resolves with the user's choice. */
  requestApproval: (detail: { tool: string; action: string; detail: string }) => Promise<ApprovalDecision>
  /** Put a multiple-choice question to the user; resolves with the chosen label, or null if dismissed. */
  requestQuestion: (detail: { question: string; options: string[] }) => Promise<string | null>
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
        this.cb.post({ type: "stderr", text: `結案摘要：${text}` })
      },
      onReview: (finding: string) => {
        // Background verifier (goal mode "review") found gaps AFTER the turn
        // ended. Advisory: the user replies "繼續" to have them addressed.
        this.cb.post({ type: "stderr", text: `⚠ 背景驗證發現缺口（回「繼續」即可補完）：\n${finding}` })
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
    // agent-core tool events → webview itemUpsert. Tool ids aren't stable
    // per-item the way app-server's are, so use the event's own id.
    const id = e.tool_use_id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
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
      const command = tool === "bash" ? argsPreview || tool : `${tool} ${argsPreview}`.trim()
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

  /** Set goal mode on the live engine: false | "review" (background) | "gate" (blocking). */
  setGoalMode(value: false | "review" | "gate"): void {
    this.goalMode = value
    this.engine?.setGoalMode(value)
  }
  private goalMode: false | "review" | "gate" = false

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
