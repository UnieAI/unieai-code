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
    if (this.engine && !model && !resume) {
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
      requestApproval: async ({ tool, action, detail }: Json) => {
        return this.cb.requestApproval({ tool, action, detail })
      },
    })
  }

  private mapToolEvent(e: Json): void {
    // agent-core tool events → webview itemUpsert. Tool ids aren't stable
    // per-item the way app-server's are, so use the event's own id.
    const id = e.tool_use_id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (e.type === "tool_use_started") {
      // Settle the text that led up to this call before the tool card lands,
      // so anything the model says afterwards starts a block below it.
      this.flushTextBlock()
      this.cb.post({
        type: "itemUpsert",
        item: { id, type: "command_execution", command: `${e.tool_name} ${e.args_preview ?? ""}`.trim(), aggregated_output: "", status: "in_progress" },
        done: false,
      })
    } else if (e.type === "tool_use_completed" || e.type === "tool_use_failed") {
      const failed = e.type === "tool_use_failed"
      this.cb.post({
        type: "itemUpsert",
        item: { id, type: "command_execution", command: e.tool_name ?? "tool", aggregated_output: String(e.result ?? e.error ?? ""), status: failed ? "failed" : "completed" },
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

  async send(text: string, model?: string, webAccess = false): Promise<void> {
    // The toolset is fixed at engine-creation time, so a flipped toggle needs a
    // fresh engine. Do this before ensureEngine so it rebuilds with the new value.
    if (webAccess !== this.webAccess) {
      this.webAccess = webAccess
      this.engine = null
    }
    this.ensureEngine(model)
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
}
