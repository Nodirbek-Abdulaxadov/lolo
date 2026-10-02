import type { Host } from "../host/types";
import type { McpHub } from "../mcp/hub";
import { listSkills } from "./claudeSetup";

/**
 * User slash commands: `.agent/commands/<name>.md` and Claude Code's `.claude/commands/<name>.md`
 * (a prompt template; `$ARGUMENTS` is replaced by what follows the command), skills
 * (`/<skill-name>`: the skill's instructions are added to the task) and MCP server prompts
 * (`/<server>:<prompt>`). Expanded into the message before the agent sees it.
 */

export interface SlashCommand {
  /** Without the slash: "review" or "github:summarize". */
  name: string;
  description: string;
}

export const COMMANDS_DIR = ".agent/commands";
const COMMAND_DIRS = [COMMANDS_DIR, ".claude/commands"];

interface FileCommand extends SlashCommand {
  template: string;
}

/** Built in; a project command file (`.agent/commands`, `.claude/commands`) with the same name replaces one. Both only read: the answer is the result. */
const BUILTIN: FileCommand[] = [
  {
    name: "review",
    description: "Review my uncommitted changes for bugs",
    // Worded as a question ("What ..."), so the message is classified as read-only by code (planner.ts: allowedKinds).
    template:
      "What problems do my uncommitted changes have? Read them with git_diff, and the code around them where needed. " +
      "Answer with the problems you find (bugs, missed cases, broken callers), each with its file and line, most serious first; say so if you find none.\n\n$ARGUMENTS",
  },
  {
    name: "commit-message",
    description: "Write a commit message for my uncommitted changes",
    template:
      "What commit message fits my uncommitted changes? Read them with git_diff. " +
      "Answer with the message only: a subject line under 72 characters in the imperative, a blank line, then a few lines on what was done and why.\n\n$ARGUMENTS",
  },
];

async function fileCommands(host: Host): Promise<FileCommand[]> {
  const own = await projectCommands(host);
  return [...own, ...BUILTIN.filter((b) => !own.some((c) => c.name === b.name))];
}

async function projectCommands(host: Host): Promise<FileCommand[]> {
  const out: FileCommand[] = [];
  for (const dir of COMMAND_DIRS) {
    if ((await host.stat(dir)) !== "dir") continue;
    for (const e of (await host.listDir(dir)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.type !== "file" || !e.name.endsWith(".md")) continue;
      const cmd = parseCommand(await host.readFile(`${dir}/${e.name}`).catch(() => ""), e.name);
      if (!out.some((c) => c.name === cmd.name)) out.push(cmd);
    }
  }
  return out;
}

function parseCommand(text: string, file: string): FileCommand {
  const raw = text.replace(/\r\n/g, "\n");
  // Optional front matter: `description: ...`
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const template = (fm ? raw.slice(fm[0].length) : raw).trim();
  const description = /^description:\s*(.+)$/m.exec(fm?.[1] ?? "")?.[1]?.trim() ?? template.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
  return { name: file.slice(0, -3).toLowerCase().replace(/[^\w-]+/g, "-"), description, template };
}

export async function listSlashCommands(host: Host, mcp?: McpHub): Promise<SlashCommand[]> {
  const files = (await fileCommands(host)).map(({ name, description }) => ({ name, description }));
  const skills = (await listSkills(host)).filter((s) => !files.some((f) => f.name === s.name)).map((s) => ({ name: s.name, description: `Skill: ${s.summary}` }));
  const prompts = (mcp?.prompts() ?? []).map((p) => ({ name: `${p.server}:${p.name}`, description: p.description ?? `MCP prompt from ${p.server}` }));
  return [...files, ...skills, ...prompts];
}

/** The message with a leading `/command args` expanded; undefined when it isn't a user command. */
export async function expandSlashCommand(text: string, host: Host, mcp?: McpHub): Promise<string | undefined> {
  const m = /^\/([\w-]+(?::[\w.-]+)?)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const [, name, args = ""] = m;
  if (name.includes(":")) {
    const [server, prompt] = name.split(":");
    if (!mcp) return undefined;
    await mcp.ready();
    return mcp.getPrompt(server, prompt, args.trim());
  }
  const cmd = (await fileCommands(host)).find((c) => c.name === name.toLowerCase());
  if (!cmd) {
    // A skill: the message keeps its name, so the run adds the skill's instructions (claudeSetup.skillsFor).
    const skill = (await listSkills(host)).find((s) => s.name.toLowerCase() === name.toLowerCase());
    return skill ? `Use the ${skill.name} skill. ${args.trim()}`.trim() : undefined;
  }
  return (cmd.template.includes("$ARGUMENTS") ? cmd.template.replace(/\$ARGUMENTS/g, args.trim()) : [cmd.template, args.trim()].filter(Boolean).join("\n\n")).trim();
}
