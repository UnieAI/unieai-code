/**
 * tools.mjs — UnieAI Code's coding toolset for the agent-core loop (productized
 * from agent-core's examples/coding-tools) — a domainToolBuilder giving agent-core a coding
 * toolset (bash / read / write / edit) where SANDBOXING AND APPROVAL ARE THE
 * TOOL'S CONCERN, not the loop's:
 *
 * - bash runs every command under the host sandbox binary
 *   (`$UNIEAI_BIN sandbox -- sh -c <cmd>`, i.e. UnieAI Code's seatbelt/landlock
 *   wrapper). On a sandbox denial it escalates through the loop-provided
 *   `runCtx.requestApproval` channel and, if the host approves, re-runs
 *   unsandboxed. The loop stays sandbox-agnostic.
 * - edit is OpenCode-style search/replace (oldString must match exactly once)
 *   — the tool dialect open models handle far better than patch grammars.
 *
 * Works with any consumer that passes `requestApproval` in the loop ctx;
 * without it, escalation is declined by default (fail closed).
 */
import { execFile } from "node:child_process";
import { toolResult } from "../../third_party/unieai-agent-core/src/tools/_util.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SANDBOX_DENIED = /operation not permitted|permission denied|sandbox/i;

function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export function buildCodingTools({ workspace, sandboxBin = process.env.UNIEAI_BIN || "unieai" } = {}) {
  const root = resolve(workspace || process.cwd());
  const inWorkspace = (p) => {
    const abs = resolve(root, p);
    if (abs !== root && !abs.startsWith(root + "/")) throw new Error(`path escapes workspace: ${p}`);
    return abs;
  };

  return async () => ({
    label: "coding",
    schemas: [
      { type: "function", function: { name: "bash", description: "Run a shell command in the workspace (sandboxed). Prefer `rg` for searching.", parameters: { type: "object", properties: { cmd: { type: "string", description: "the command line to run" } }, required: ["cmd"] } } },
      { type: "function", function: { name: "read", description: "Read a file (workspace-relative path).", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
      { type: "function", function: { name: "write", description: "Create or overwrite a file with the given content.", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
      { type: "function", function: { name: "edit", description: "Edit a file by exact search/replace. oldString must appear exactly once.", parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["filePath", "oldString", "newString"] } } }
    ],
    executors: {
      async bash(args, runCtx = {}) {
        const cmd = String(args?.cmd || "").trim();
        if (!cmd) return toolResult({ ok: false, modelText: "error: cmd is required" });
        const sandboxed = await run(sandboxBin, ["sandbox", "--", "sh", "-c", cmd], { cwd: root });
        const denied = sandboxed.code !== 0 && SANDBOX_DENIED.test(sandboxed.stderr + sandboxed.stdout);
        if (!denied) {
          return toolResult({ ok: sandboxed.code === 0, modelText: `exit ${sandboxed.code}\n${(sandboxed.stdout + sandboxed.stderr).slice(0, 8000)}` });
        }
        // Sandbox denial → escalate through the host's approval channel.
        const decision = runCtx.requestApproval
          ? await runCtx.requestApproval({ tool: "bash", action: "run outside the sandbox", detail: cmd })
          : "decline";
        if (decision !== "accept" && decision !== "acceptForSession") {
          return toolResult({ ok: false, modelText: `exit ${sandboxed.code}\n(blocked by sandbox; escalation ${runCtx.requestApproval ? "declined by user" : "unavailable"})\n${sandboxed.stderr.slice(0, 2000)}` });
        }
        const raw = await run("sh", ["-c", cmd], { cwd: root });
        return toolResult({ ok: raw.code === 0, modelText: `exit ${raw.code} (approved, unsandboxed)\n${(raw.stdout + raw.stderr).slice(0, 8000)}` });
      },
      async read(args) {
        try {
          const body = await readFile(inWorkspace(String(args?.filePath || "")), "utf8");
          return toolResult({ modelText: body.slice(0, 32_000) });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async write(args) {
        try {
          const abs = inWorkspace(String(args?.filePath || ""));
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, String(args?.content ?? ""), "utf8");
          return toolResult({ modelText: `wrote ${args.filePath}` });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async edit(args) {
        try {
          const abs = inWorkspace(String(args?.filePath || ""));
          const before = await readFile(abs, "utf8");
          const oldString = String(args?.oldString ?? "");
          const hits = before.split(oldString).length - 1;
          if (hits === 0) return toolResult({ ok: false, modelText: "error: oldString not found — read the file and copy the exact text" });
          if (hits > 1) return toolResult({ ok: false, modelText: `error: oldString matches ${hits} times — include more surrounding context` });
          await writeFile(abs, before.replace(oldString, String(args?.newString ?? "")), "utf8");
          return toolResult({ modelText: `edited ${args.filePath}` });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      }
    }
  });
}
