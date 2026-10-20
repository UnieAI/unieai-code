// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-artifacts.mjs — the `publish_artifact` tool: put a page the agent
 * wrote on ava (agent.unieai.com) at a private URL, and update it in place.
 *
 * A uac host plugin (not in uac-plugins: it needs the UnieAI Code login in
 * `unieai.json`, which Studio's runtime does not have). Loaded through the uac
 * patch (config.mjs `renderPatch`) with `{ home }`; the account is read on
 * every call, so a `unieai login --rabi` during a session takes effect at once.
 * The work is in unieai-artifacts-core.mjs; the `artifact` skill bundled in
 * ./skills teaches the model how to write a page for it.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { currentDirectory, sessionCwd } from "./uac-plugins/unieai-edit-dsh.mjs";
import {
  ArtifactsClient,
  ArtifactsError,
  IdMemory,
  LIMITS,
  list,
  publish,
  read,
  remove,
  renderList,
  renderPublished,
  renderRead,
  resolveAccount,
  unieaiHome,
  workspaceRoot,
} from "./unieai-artifacts-core.mjs";

export const name = "unieai-artifacts";
export const inject = ["tools"];

export const TOOL_NAME = "publish_artifact";

export const DESCRIPTION =
  "Publish a web page you wrote (a report, dashboard, diagram, small tool) to the user's UnieAI gallery at a private link, and update it in place later. " +
  "Use it for a page meant for people to read or use, not for code that belongs in the repository. " +
  "Actions: publish (path to an .html file or a directory with index.html, or inline files; publishing the same path again updates the same page, " +
  "and id updates a given page), list, read (an existing page's files, e.g. before you rewrite it), delete. " +
  "Only delete when the user asks for that page to be deleted. " +
  "Pages are inline-only: no external http(s) scripts, styles, fonts or images (a publish that has them is refused with what to inline). " +
  `Limits: ${LIMITS.maxFileBytes / 1048576} MiB per file, ${LIMITS.maxDeps} files besides index.html, ${LIMITS.maxShareBytes / 1048576} MiB per page. ` +
  "Load the artifact skill before writing a page for it.";

export const PARAMETERS = {
  action: { type: "string", enum: ["publish", "list", "read", "delete"], required: true, description: "What to do." },
  path: { type: "string", description: "publish: an .html file (it becomes index.html) or a directory with index.html at its top." },
  files: {
    type: "array",
    description: "publish, instead of path: the page's files; one must be index.html.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", required: true, description: 'Site path, e.g. "index.html".' },
        content: { type: "string", description: "Text content." },
        content_base64: { type: "string", description: "Binary content, base64." },
      },
    },
  },
  title: { type: "string", description: "publish: the page's name, 2-4 words (default: the page's <title>)." },
  description: { type: "string", description: "publish: one sentence for the gallery card." },
  id: { type: "string", description: "publish: the artifact to update (default: the one this path was published as). read/delete: the artifact." },
  expected_version: { type: "number", description: "publish: the version your update is based on (default: the version last published from this path)." },
  merge: { type: "boolean", description: "publish: on a version conflict, lay your files over the current version's (same path wins) and retry once." },
  visibility: { type: "string", enum: ["private", "org"], description: 'publish: "private" (default) or "org". Only the user makes a page public, in the web UI.' },
  header: {
    type: "object",
    additionalProperties: false,
    description: "publish: the viewer's header bar above the page (never draw one in the page itself).",
    properties: {
      title: { type: "string", description: "Header title (default: the page title)." },
      description: { type: "string", description: "One line under the title." },
      icon: { type: "string", description: "One short generic word or an emoji, e.g. chart." },
      show_author: { type: "boolean", description: "Show the author's name." },
    },
  },
  save_to: { type: "string", description: "read: also write the page's files into this directory, which then publishes back to the same page." },
};

const textOutput = { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] };

/**
 * Runs one tool call. Exported for tests and direct invocation; `cwd` is where
 * relative paths resolve, `workspace` the root paths are remembered under.
 */
export async function runArtifactAction(args, { home = unieaiHome(), cwd = process.cwd(), workspace, fetchImpl } = {}) {
  const { baseUrl, apiKey, account } = resolveAccount(home);
  const client = new ArtifactsClient({ baseUrl, apiKey, fetchImpl });
  const memory = new IdMemory(home);
  const root = workspace ?? workspaceRoot(cwd);
  switch (args.action) {
    case "publish":
      return renderPublished(await publish({ client, memory, account, cwd, workspace: root, args }));
    case "list":
      return renderList(await list({ client, memory }));
    case "read":
      if (!args.id) throw new ArtifactsError("bad_request", "read needs id (see action list).");
      return renderRead(await read({ client, memory, account, cwd, workspace: root, id: args.id, saveTo: args.save_to }), client);
    case "delete":
      if (!args.id) throw new ArtifactsError("bad_request", "delete needs id.");
      return remove({ client, memory, id: args.id });
    default:
      throw new ArtifactsError("bad_request", `unknown action "${args.action}": use publish, list, read or delete.`);
  }
}

export function apply(ctx, config = {}) {
  const home = config.home ?? unieaiHome();
  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: textOutput,
      presentCall: (args) => ({ card: "generic", title: `Artifact: ${args.action}${args.path ? ` ${args.path}` : args.id ? ` ${args.id}` : ""}` }),
      async execute(args, exec) {
        const session = sessionCwd(exec);
        const cwd = (await currentDirectory(ctx, exec)) ?? session ?? process.cwd();
        try {
          return await runArtifactAction(args, { home, cwd, workspace: workspaceRoot(session ?? cwd) });
        } catch (error) {
          // ArtifactsError messages are written for the model; others get the code.
          if (error instanceof ArtifactsError) throw new Error(error.message);
          throw error;
        }
      },
    }),
  );
}
