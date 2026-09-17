// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-skills.mjs — skills from UnieAI's directories instead of dsh's.
 *
 * dsh's skill-filesystem reads project skills from `<project>/.dsh/skills`
 * and user skills from `$DSH_HOME/skills`. UnieAI Code keeps one layout for
 * both engines: project skills in `<project>/.unieai/skills` and user skills
 * in `~/.unieai/skills` (CODEX_HOME), next to AGENTS.md. This plugin is
 * skill-filesystem with those roots; `.agents/skills` (project and user),
 * custom dirs and bundled skills are unchanged.
 *
 * Replace the stock row in the patch:
 *   - id: skill-filesystem
 *     disabled: true
 *   - insert: [{ id: unieai-skills, name: <file URL>, config: { home: ~/.unieai } }]
 *
 * Config (all optional): `home` (user skills live in `<home>/skills`,
 * default `$UNIEAI_HOME`, `$CODEX_HOME`, then `~/.unieai`), `projectDirs`
 * (project dirs whose `skills/` is read, highest precedence first; default
 * `[".unieai"]`), plus every skill-filesystem option except `dshHome`.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

export const name = "unieai-skills";
export const inject = ["skills"];

export const DEFAULT_PROJECT_DIRS = Object.freeze([".unieai"]);

/** Tools whose writes can add or change a skill. */
const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch"]);

export function unieaiHome(env = process.env) {
  return resolve(env.UNIEAI_HOME || env.CODEX_HOME || join(homedir(), ".unieai"));
}

/** Replace the project `.dsh/skills` root with one root per `projectDirs` entry. */
export function remapRoots(roots, projectDirs) {
  return roots.flatMap((root) =>
    root.source === "project-dsh" && root.projectRoot !== undefined
      ? projectDirs.map((dir) => ({ ...root, path: join(root.projectRoot, dir, "skills") }))
      : [root],
  );
}

export class UnieAISkillProvider extends FileSystemSkillProvider {
  constructor(ctx, control, config = {}) {
    const { home, projectDirs, ...rest } = config;
    super(ctx, control, { ...rest, dshHome: home ?? unieaiHome() });
    this.projectDirs = Array.isArray(projectDirs) && projectDirs.length > 0 ? [...projectDirs] : [...DEFAULT_PROJECT_DIRS];
  }

  async roots(cwd) {
    return remapRoots(await super.roots(cwd), this.projectDirs);
  }
}

export function apply(ctx, config = {}) {
  let provider;
  ctx.skills.registerProvider((control) => {
    provider = new UnieAISkillProvider(ctx, control, config);
    return provider;
  });
  ctx.effect(function* () {
    yield async () => {
      await provider?.dispose();
    };
  }, "unieai-skills watcher");
  ctx.on("fs/observed", (target, _observation, actor) => {
    if (!actor || !MUTATING_TOOLS.has(actor.name)) return;
    provider?.observeHostMutation(target.displayPath);
  });
}
