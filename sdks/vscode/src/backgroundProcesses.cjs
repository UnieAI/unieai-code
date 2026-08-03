/**
 * backgroundProcesses.cjs — turn process-manager snapshots into the text the
 * status bar and the quick pick show.
 *
 * Split out from the UI because the interesting decisions here are editorial,
 * not visual: which of exit-code-or-uptime is the number worth showing, when
 * the indicator should disappear entirely, and how much of a command line to
 * keep. Those are exactly the parts worth pinning down in tests.
 *
 * Plain CommonJS with a sibling `.d.cts` so it is unit-testable under
 * `node --test`; the extension has no TypeScript-aware test runner.
 */

/** How much of a command line survives into a one-line row. */
const COMMAND_CHARS = 60

/** Commands listed in the tooltip before it starts to be a wall of text. */
const TOOLTIP_ROWS = 8

function isRunning(process) {
  return process != null && process.status === "running"
}

/**
 * The one number worth showing for a process.
 *
 * While it runs, "is it making progress" is the question and uptime answers it.
 * Once it is dead, uptime is meaningless and the exit code is the whole story —
 * a signal name stands in when it was killed rather than returned.
 */
function describeLifetime(process) {
  if (isRunning(process)) {
    return `up ${Math.round(Number(process?.uptimeMs ?? 0) / 1000)}s`
  }
  return `exit ${process?.exitCode ?? process?.signal ?? "?"}`
}

/** One row: id, state, the lifetime number, buffered output, command. */
function describeProcess(process) {
  const dropped = process?.droppedLines ? ` (+${process.droppedLines} dropped)` : ""
  const command = String(process?.command ?? "").slice(0, COMMAND_CHARS)
  return `${process?.id ?? "?"} · ${process?.status ?? "?"} · ${describeLifetime(process)} · ${Number(process?.outputLines ?? 0)} line(s)${dropped} · ${command}`
}

/**
 * What the status bar should show, or null when it should hide.
 *
 * Only RUNNING processes count. The manager keeps corpses readable for five
 * minutes so their exit code can still be asked about, but a badge that said
 * "3" for a build that finished four minutes ago would be actively misleading —
 * the whole point of the indicator is "something is still going".
 */
function summarizeProcesses(processes) {
  const rows = Array.isArray(processes) ? processes : []
  const running = rows.filter(isRunning)
  if (running.length === 0) {
    return null
  }
  const listed = running.slice(0, TOOLTIP_ROWS).map((p) => `${p.id}  ${String(p.command ?? "").slice(0, COMMAND_CHARS)}`)
  const rest = running.length - listed.length
  if (rest > 0) {
    listed.push(`…and ${rest} more`)
  }
  return {
    running: running.length,
    text: `$(pulse) ${running.length}`,
    tooltip: [`${running.length} background process(es) running`, ...listed, "Click to read or stop them."].join("\n"),
  }
}

module.exports = { describeLifetime, describeProcess, isRunning, summarizeProcesses }
