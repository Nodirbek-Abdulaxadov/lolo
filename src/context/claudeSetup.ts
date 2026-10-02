import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Host } from "../host/types";

/**
 * Projects set up for Claude Code (or other agents) work here too:
 * - CLAUDE.md / AGENTS.md: project instructions, in the system prompt.
 * - .claude/skills/<name>/SKILL.md (and .agent/skills, ~/.claude/skills): listed in the
 *   system prompt; a skill's full text is added to the task when the message asks for it.
 * - .claude/commands/*.md: slash commands (see slashCommands.ts).
 * - .claude/settings(.local).json permissions: `Bash(...)` rules extend the command allowlist.
 * - .mcp.json: MCP servers (see mcp/hub.ts).
 */

const INSTRUCTION_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"];
const SKILL_DIRS = [".claude/skills", ".agent/skills"];

export interface Instructions {
  text: string;
  /** Files the text came from. */
  sources: string[];
}

/** Project instructions from CLAUDE.md / AGENTS.md (identical copies once). `@path` imports are inlined one level deep. */
export async function loadInstructions(host: Host): Promise<Instructions> {
  const seen = new Set<string>();
  const parts: string[] = [];
  const sources: string[] = [];
  for (const f of INSTRUCTION_FILES) {
    if ((await host.stat(f)) !== "file") continue;
    const text = (await host.readFile(f).catch(() => "")).replace(/\r\n/g, "\n").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(await inlineImports(host, text, path.posix.dirname(f)));
    sources.push(f);
  }
  return { text: parts.join("\n\n"), sources };
}

/** `@docs/style.md` lines (Claude Code's import syntax) replaced by the file's content. */
async function inlineImports(host: Host, text: string, dir: string): Promise<string> {
  const lines = await Promise.all(
    text.split("\n").map(async (line) => {
      const m = /^\s*@([\w./-]+\.(md|txt))\s*$/.exec(line);
      if (!m) return line;
      const p = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, m[1]));
      if (p.startsWith("..") || (await host.stat(p)) !== "file") return line;
      return (await host.readFile(p).catch(() => line)).trim();
    }),
  );
  return lines.join("\n");
}

export interface Skill {
  name: string;
  /** First sentence of the description, for the system prompt. */
  summary: string;
  /** Full description (used to match the message). */
  description: string;
  /** Workspace-relative path of SKILL.md, or absolute for user skills. */
  path: string;
  body: string;
}

/** Frontmatter `name` and `description` (plain or `|`/`>` block) of a SKILL.md. */
export function parseSkill(raw: string, fallbackName: string, file: string): Skill {
  const text = raw.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = fm?.[1] ?? "";
  const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(meta)?.[1]?.trim() || fallbackName;
  let description = "";
  const d = /^description:[ \t]*(.*)$/m.exec(meta);
  if (d) {
    if (/^[|>][-+]?\s*$/.test(d[1])) {
      const after = meta.slice(d.index + d[0].length + 1).split("\n");
      const block: string[] = [];
      for (const l of after) {
        if (l.trim() && !/^\s/.test(l)) break;
        block.push(l.trim());
      }
      description = block.join(" ").trim();
    } else description = d[1].replace(/^["']|["']$/g, "").trim();
  }
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  if (!description) description = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
  const first = /^.*?[.!?](\s|$)/.exec(description)?.[0]?.trim() ?? description;
  return { name, summary: first.length > 160 ? first.slice(0, 157) + "..." : first, description, path: file, body };
}

/** Skills of the workspace, then the user's (~/.claude/skills) that the workspace doesn't override; `userDir` null: the workspace's only. */
export async function listSkills(host: Host, userDir: string | null = path.join(homedir(), ".claude", "skills")): Promise<Skill[]> {
  const out: Skill[] = [];
  const names = new Set<string>();
  for (const dir of SKILL_DIRS) {
    if ((await host.stat(dir)) !== "dir") continue;
    for (const e of (await host.listDir(dir)).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${dir}/${e.name}/SKILL.md`;
      if (e.type !== "dir" || (await host.stat(file)) !== "file") continue;
      const s = parseSkill(await host.readFile(file), e.name, file);
      if (!names.has(s.name)) out.push(s), names.add(s.name);
    }
  }
  if (userDir === null) return out;
  try {
    for (const e of readdirSync(userDir).sort()) {
      const file = path.join(userDir, e, "SKILL.md");
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const s = parseSkill(readFileSync(file, "utf8"), e, file);
      if (!names.has(s.name)) out.push(s), names.add(s.name);
    }
  } catch {
    /* no user skills */
  }
  return out;
}

/**
 * Skills the message asks for, decided without the model: `/name`, the full name, a word of
 * the name next to "skill" ("jira skill orqali"), or a word of the name the description
 * spells as a proper noun ("Jira", "Figma"): a product the message can only mean one way.
 * A common word of a name ("migration", "report") alone never loads a skill.
 */
export function skillsFor(message: string, skills: Skill[]): Skill[] {
  const text = message.toLowerCase();
  const words = new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const mentionsSkill = /\bskill|skil+ni|скилл/i.test(message);
  return skills.filter((s) => {
    const name = s.name.toLowerCase();
    if (text.includes(`/${name}`) || new RegExp(`(^|[^\\w-])${name.replace(/[-]/g, "[- ]")}([^\\w-]|$)`).test(text)) return true;
    // "skill" in a name ("write-a-skill") is the word that marks every skill request, not this skill.
    const parts = name.split(/[-_\s]+/).filter((w) => w.length >= 3 && !/^skills?$/.test(w));
    if (mentionsSkill && parts.some((w) => words.has(w))) return true;
    // "jira skill orqali ...": the product the skill is about, even when its name doesn't say it.
    if (mentionsSkill && [...words].some((w) => w.length >= 3 && namesProduct(w, s.description, text))) return true;
    return parts.some((w) => words.has(w) && namesProduct(w, s.description, text));
  });
}

/** Generic capitalized terms that don't identify what a skill is about. */
const GENERIC = new Set(["api", "rest", "http", "https", "json", "yaml", "url", "ui", "db", "sql", "cli", "ci", "ef", "core", "trigger", "skip", "use", "the", "never", "always", "todo"]);

/** Runs of capitalized words inside sentences of `text`, lowercased: "work in Jira via" → [jira], "set up Claude Code hooks" → [claude, code]. */
function nameRuns(text: string): string[][] {
  // After a word in lower case or one ending in , ; : ("Jira, Confluence"), not at a sentence start.
  return [...text.matchAll(/(?<=(?:^|\s)(?:[a-z]\S*|\S*[,;:])\s+)[A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*)*/g)].map((m) => m[0].toLowerCase().split(/[ \t]+/));
}

/**
 * `word` (lowercase, from `text`) names a product the description is about: capitalized inside
 * a sentence ("work in Jira via") or in capitals ("JIRA"). A later word of a longer name
 * ("Claude Code", "EF Core") counts only when `text` has the name up to it ("claude code"):
 * alone it is a common word ("fix the code").
 */
function namesProduct(word: string, description: string, text: string): boolean {
  if (GENERIC.has(word)) return false;
  if (new RegExp(`\\b${word.toUpperCase()}\\b`).test(description)) return true;
  return nameRuns(description).some((run) => {
    const i = run.indexOf(word);
    return i === 0 || (i > 0 && text.includes(run.slice(0, i + 1).join(" ")));
  });
}

/** Whether a todo refers to the skill (its name, or a product its name mentions: "Create Jira issue"). */
export function skillMentioned(todo: string, s: Skill): boolean {
  const t = todo.toLowerCase();
  if (t.includes(s.name.toLowerCase())) return true;
  return s.name.toLowerCase().split(/[-_\s]+/).some((w) => w.length >= 3 && new RegExp(`\\b${w}\\b`).test(t) && namesProduct(w, s.description, t));
}

/** A skill's instructions for the task message. */
export function skillBlock(s: Skill): string {
  // Each command runs in a new shell: variables from .env have to be loaded in the same command.
  // Shell quoting of JSON bodies with variables is where small models fail ('$VAR' inside single
  // quotes is sent literally, and curl exits 0 on HTTP errors): a Python script avoids both.
  const api = /\bcurl\b|REST|\bAPI\b|https?:\/\//.test(s.body)
    ? "\nFor API calls, write one short Python script per step and run it with run_command as `python3 - <<'EOF'` ... `EOF`: read the .env file in the script " +
      "(a line `KEY=value` per variable), send the request with urllib.request, build JSON bodies with json.dumps, call raise_for_status-style checks " +
      "(urllib raises HTTPError on 4xx/5xx; print its body), and print only what you need next (a key, an id). Never print secret values. Shell variables in commands only " +
      "expand outside single quotes."
    : /\.env\b/.test(s.body)
      ? "\nCommands run in a fresh shell each time: load the variables in the same command, e.g. `set -a && . ./.env && set +a && ...`. Never print secret values."
      : "";
  // Skills are loaded only when the message asks for them, so the user has already said yes:
  // a skill's "ask before doing it" step made the model end every run with that question.
  const asked = "\nThe user asked for this skill in this conversation: that is their confirmation. Skip any step that asks whether to use it (e.g. \"should I open a task?\") and do its actions now.";
  return `Skill "${s.name}" (${s.path}): follow these instructions for this task.${asked}${api}\n\n${s.body}`;
}

export interface ClaudePermissions {
  /** Command prefixes to run without asking; "*" allows every command. */
  allow: string[];
  /** Command prefixes that are refused. */
  deny: string[];
}

/** `Bash(npm test:*)`, `Bash(git status)`, `Bash(*)` rules from .claude/settings.json and settings.local.json. */
export async function claudePermissions(host: Host): Promise<ClaudePermissions> {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
    if ((await host.stat(f)) !== "file") continue;
    let perms: { allow?: unknown; deny?: unknown } | undefined;
    try {
      perms = JSON.parse(await host.readFile(f)).permissions;
    } catch {
      continue;
    }
    for (const [list, into] of [[perms?.allow, allow], [perms?.deny, deny]] as const) {
      if (!Array.isArray(list)) continue;
      for (const rule of list) {
        const m = typeof rule === "string" ? /^Bash\((.*)\)$/.exec(rule.trim()) : null;
        if (!m) continue;
        const prefix = m[1].replace(/(:\*|\s\*|\*)$/, "").trim();
        into.push(prefix || "*");
      }
    }
  }
  return { allow: [...new Set(allow)], deny: [...new Set(deny)] };
}

/** Servers listed in `disabledMcpjsonServers` of .claude/settings(.local).json. */
export function disabledMcpServers(root: string): string[] {
  const out: string[] = [];
  for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
    try {
      const d = JSON.parse(readFileSync(path.join(root, f), "utf8"));
      if (Array.isArray(d.disabledMcpjsonServers)) out.push(...d.disabledMcpjsonServers.map(String));
    } catch {
      /* missing or invalid */
    }
  }
  return out;
}
