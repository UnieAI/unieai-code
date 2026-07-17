/**
 * engine.mjs — one conversation on the agent-core loop, surface-agnostic.
 *
 * The TUI and the VS Code panel both drive this: they provide callbacks
 * (onText/onReasoning/onToolEvent/requestApproval) and call send() per user
 * turn. History persistence and toolset assembly live here.
 */
import { buildToolset } from "../../third_party/unieai-agent-core/src/toolset.mjs";
import { runAgentLoop } from "../../third_party/unieai-agent-core/src/loop.mjs";
import { buildSystemPrompt } from "../../third_party/unieai-agent-core/src/prompt.mjs";
import { buildCodingTools } from "./tools.mjs";
import { loadCredentials, applyUpstreamEnv, sandboxBin } from "./config.mjs";
import { newSessionId, saveSession, loadSession } from "./session.mjs";

const CODE_IDENTITY =
  "You are UnieAI Code, a coding agent running in a CLI harness attached to the user's workspace.";

const CODE_TOOL_GUIDANCE = [
  "- bash — run shell commands in the workspace (sandboxed; escalations ask the user). Prefer `rg` for searching.",
  "- read / write / edit — inspect and change files. edit is exact search/replace: oldString must match exactly once; read the file first and copy the exact text.",
  "- Follow the codebase's conventions and never assume a library is available — verify it is already used in the project first.",
  "- Verify with the project's own checks (tests/lint/typecheck) when they exist. Never commit unless the user explicitly asks."
];

export function createEngine({
  workspace,
  model,
  resume = null,
  onText = () => {},
  onReasoning = () => {},
  onToolEvent = () => {},
  requestApproval = null
} = {}) {
  const credentials = loadCredentials();
  if (!credentials.signedIn) {
    throw new Error("not signed in — run `unieai login` first");
  }
  applyUpstreamEnv(credentials);

  const resumed = resume ? loadSession(resume) : null;
  const sessionId = resumed?.id || newSessionId();
  const activeModel = model || resumed?.model || credentials.models[0]?.id;
  if (!activeModel) {
    throw new Error(`no models available — add models in UnieAI Studio (${credentials.studioUrl}/models)`);
  }

  const messages = resumed?.messages || [
    {
      role: "system",
      content: buildSystemPrompt({
        runtimeContext: { knowledgeBases: [], workspace: {} },
        identity: CODE_IDENTITY,
        runtime: "UnieAI Code (agent-core loop, sandboxed shell tools)",
        extraToolGuidance: CODE_TOOL_GUIDANCE
      })
    }
  ];

  const emitter = {
    writeContent: (d) => onText(d),
    writeReasoning: (d) => onReasoning(d),
    writeMetadata: () => {},
    emitToolEvent: (e) => onToolEvent(e)
  };

  let toolsetPromise = null;
  function toolset(ctx) {
    toolsetPromise ||= buildToolset({
      runtimeContext: { workspace: {} },
      ctx,
      domainToolBuilders: [buildCodingTools({ workspace, sandboxBin: sandboxBin() })]
    });
    return toolsetPromise;
  }

  return {
    sessionId,
    model: activeModel,
    models: credentials.models,
    messages,

    /** Run one user turn; resolves when the turn ends. */
    async send(text, { abortSignal = null } = {}) {
      messages.push({ role: "user", content: text });
      const ctx = {
        baseModelSlug: activeModel,
        callerKey: credentials.gatewayApiKey,
        requestId: `${sessionId}-${messages.length}`,
        maxSteps: 24,
        abortSignal,
        requestApproval
      };
      const result = await runAgentLoop({ messages, toolset: await toolset(ctx), emitter, ctx });
      saveSession({ id: sessionId, messages, model: activeModel, cwd: workspace });
      return result;
    }
  };
}
