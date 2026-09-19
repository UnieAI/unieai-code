// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-shell-command.mjs — the composer's `!command` on engines that run
 * their tools elsewhere.
 *
 * codex runs a user's `!` command itself, outside the model's turn, shows it
 * as a command card (source `userShell`), and puts the command and its output
 * in the conversation so the model knows what the user saw. dsh has no such
 * entry point, so the bridge runs the command in the thread's directory with
 * the user's shell and hands the model a bounded note with its next prompt.
 */
import { spawn } from "node:child_process";

/** What the model is given of one command's output, at most. */
export const NOTE_OUTPUT_LIMIT = 4000;
/** How many notes wait for the next prompt; older ones are dropped. */
export const NOTES_KEPT = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 1_000_000;

/**
 * Run `command` with the user's shell in `cwd`.
 * @returns {Promise<{ output: string, exitCode: number, durationMs: number }>}
 */
export function runUserShellCommand({ command, cwd, timeoutMs = null, shell = process.env.SHELL || "/bin/sh", env = process.env }) {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    const append = (chunk) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8");
    };
    let child;
    try {
      child = spawn(shell, ["-lc", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ output: String(error.message), exitCode: 127, durationMs: 0 });
      return;
    }
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const limit = timeoutMs === null || timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
    const timer = limit > 0 ? setTimeout(() => child.kill("SIGKILL"), limit) : null;
    child.on("error", (error) => {
      append(Buffer.from(String(error.message)));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (signal) output += `\n[killed: ${signal}]`;
      resolve({ output, exitCode: code ?? 124, durationMs: Date.now() - started });
    });
  });
}

/** One command and its output, as the model reads it (bounded). */
export function shellNote(command, { output, exitCode }) {
  const text = String(output ?? "");
  const shown =
    text.length > NOTE_OUTPUT_LIMIT
      ? `${text.slice(0, NOTE_OUTPUT_LIMIT / 2)}\n[... ${text.length - NOTE_OUTPUT_LIMIT} characters omitted ...]\n${text.slice(-NOTE_OUTPUT_LIMIT / 2)}`
      : text;
  return `<user_shell_command>\n<command>${command}</command>\n<exit_code>${exitCode}</exit_code>\n<output>\n${shown}\n</output>\n</user_shell_command>`;
}

/** A prompt with the user's recent `!` commands before it. */
export function withShellNotes(notes, text) {
  if (!notes?.length) return text;
  return `The user ran these commands in the terminal since your last turn:\n${notes.join("\n")}\n\n${text}`;
}
