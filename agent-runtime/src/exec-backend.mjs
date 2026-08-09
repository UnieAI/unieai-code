/**
 * exec-backend.mjs — where the agent's shell commands actually execute.
 *
 * The default is the local sandbox: commands run on this machine, wrapped by the
 * UnieAI sandbox binary. That is the right answer when the workspace IS the
 * user's machine, but it is not the only case — a workspace can be a checkout
 * whose toolchain lives in a container (a prepared test image, a devcontainer, a
 * CI environment). There the files are local and the *interpreter* is not, so
 * read/write/edit stay on the filesystem while bash has to cross into the
 * container.
 *
 * A backend is just `{ argv(cmd), describe() }`: given a command line, return the
 * argv that runs it. Everything else — sandbox denial handling, approval
 * escalation, timeouts — is unchanged and lives in the tool.
 */
import { shellArgv, sandboxArgv } from "./portable-exec.mjs";

/** Commands run on this machine, inside the UnieAI sandbox. The default. */
export function localSandboxBackend(sandboxBin) {
  return {
    kind: "local",
    argv: (cmd) => sandboxArgv(sandboxBin, cmd),
    // The unsandboxed rerun used after the user approves an escalation.
    escalatedArgv: (cmd) => shellArgv(cmd),
    describe: () => "local sandbox",
  };
}

/**
 * Commands run inside an already-running container via `docker exec`.
 *
 * The workspace is expected to be bind-mounted into the container at
 * `workdir`, so the files the model edits locally are the files the command
 * sees. `shell` defaults to a login shell because prepared images usually put
 * their toolchain on PATH through profile scripts.
 *
 * There is no escalation path: the container IS the boundary, so a denial has
 * nothing weaker to fall back to.
 */
export function dockerExecBackend({ container, workdir = "/testbed", shell = "/bin/bash", docker = "docker", env = {}, shareWithHost = true } = {}) {
  if (!container) throw new Error("dockerExecBackend requires a container id or name");
  // When the workdir is a bind mount that host-side tools also write to, the
  // container's user must not create files the host cannot touch. Two sources
  // dominate in practice: Python bytecode caches (disabled outright — they are
  // pure derived data) and a restrictive umask on everything else.
  const shared = shareWithHost ? { PYTHONDONTWRITEBYTECODE: "1", ...env } : env;
  const envArgs = Object.entries(shared).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const wrap = (cmd) => (shareWithHost ? `umask 000; ${cmd}` : cmd);
  return {
    kind: "docker",
    argv: (cmd) => [docker, "exec", "-w", workdir, ...envArgs, container, shell, "-lc", wrap(cmd)],
    escalatedArgv: null,
    describe: () => `docker exec ${container}`,
  };
}

/** Normalize whatever a caller passed into a backend object. */
export function resolveBackend(backend, sandboxBin) {
  if (backend && typeof backend.argv === "function") return backend;
  return localSandboxBackend(sandboxBin);
}
