import { namedFiles } from "../agent/planner";
import { asksForTests, countTests, isTestFile, NO_NEW_TESTS, TESTS_PROTECTED } from "../agent/testGuard";
import { enabledEditTools } from "../edit/formats";
import { answer, done } from "./control";
import { getDiagnostics } from "./diagnostics";
import { createFile, editFile, editLines, listDir, readFile, readSymbol, rewriteFile } from "./fileTools";
import { deleteFile, moveFile } from "./fileOps";
import { gitBlame, gitDiff, gitLog } from "./gitTools";
import { explore } from "./exploreTool";
import { remember } from "./memoryTool";
import { resolveWorkspacePath, writeForbidden } from "./paths";
import { processLogs, startProcess } from "./processes";
import { runCommand } from "./runCommand";
import { search } from "./search";
import { findDefinition, findReferences, renameSymbol } from "./symbolTools";
import { fetchUrl, webSearchTool } from "./webTools";
import type { ToolContext, ToolDef } from "./types";
import { Schema, validate } from "./validate";

export type AgentMode = "ask" | "agent" | "plan";

/**
 * Tools offered to the model. ask_user is deliberately absent: small models ask
 * pointless questions instead of working. Unclear messages get a clarifying reply
 * from the planner, and the loop itself asks the user only when a todo is stuck.
 */
export const ALL_TOOLS: ToolDef[] = [
  readFile, readSymbol, search, listDir, getDiagnostics,
  editFile, rewriteFile, editLines, createFile, runCommand,
  findDefinition, findReferences, renameSymbol,
  moveFile, deleteFile, gitDiff, gitLog, gitBlame,
  startProcess, processLogs, webSearchTool, fetchUrl, remember, explore,
  done, answer,
];

/** Longest `thought` the schema allows: qwen3.5 sometimes reasons in it until the token limit (55 s a step). */
export const THOUGHT_MAX = 800;

/** Tools that change an existing file's lines: the model must have seen the file first. */
const EDITS_EXISTING = new Set(["edit", "rewrite_file", "edit_lines"]);

const MOVES_CODE = /\b(?:move[sd]?|moving|extract(?:s|ed|ing)?|split(?:s|ting)?|out of|(?:factor|pull)(?:s|ed|ing)? out)\b/i;
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|py|cs|fs|go|java|kt|rs|rb|php|cpp|cc|c|hpp|h|swift)$/;

/**
 * When the todo or the message moves code and `path` is a new code file: the existing code files they
 * name, if the model has read none of them yet (one is enough to copy from). Otherwise [].
 */
async function unreadSources(path: string, ctx: ToolContext): Promise<string[]> {
  const text = `${ctx.todo ?? ""}\n${ctx.message ?? ""}`;
  if (!CODE_FILE.test(path) || !MOVES_CODE.test(text)) return [];
  const named: string[] = [];
  for (const name of namedFiles(text)) {
    const r = resolveWorkspacePath(ctx.host.root, name);
    if ("error" in r || r.path === path || !CODE_FILE.test(r.path) || named.includes(r.path)) continue;
    if (ctx.seen!.has(r.path)) return [];
    if ((await ctx.host.stat(r.path)) === "file") named.push(r.path);
  }
  return named;
}

const MOVE_FILE = /\b(?:move|rename)\s+`?([\w./-]+\.\w+)`?\s+(?:to|into|as)\s+`?([\w./-]+\.\w+)`?/gi;

/** The existing file the user's message moves to `path` ("Move billing/utils.py to billing/money/format.py"). */
async function movedFrom(path: string, ctx: ToolContext): Promise<string | undefined> {
  for (const m of (ctx.message ?? "").matchAll(MOVE_FILE)) {
    const from = resolveWorkspacePath(ctx.host.root, m[1]);
    const to = resolveWorkspacePath(ctx.host.root, m[2]);
    if ("error" in from || "error" in to || to.path !== path) continue;
    if ((await ctx.host.stat(from.path)) === "file") return from.path;
  }
  return undefined;
}

/** How many test declarations a write adds to `args.path` (negative when it removes some). */
async function addedTests(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<number> {
  const path = String(args.path);
  const current = (await ctx.host.stat(path)) === "file" ? await ctx.host.readFile(path) : "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tool) {
    case "create_file":
    case "rewrite_file":
      return countTests(str(args.content)) - countTests(current);
    case "edit":
      return countTests(str(args.replace)) - countTests(str(args.search));
    case "edit_lines": {
      const lines = current.replace(/\r\n/g, "\n").split("\n");
      return countTests(str(args.content)) - countTests(lines.slice(Number(args.start_line) - 1, Number(args.end_line)).join("\n"));
    }
    default:
      return 0;
  }
}

export interface Action {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
}

/** `policy`: a well-formed call the orchestration refuses (read before edit, protected tests), not a model format error. */
export type Checked = { ok: true; tool: ToolDef; args: any } | { ok: false; error: string; policy?: boolean };

export class ToolRegistry {
  /** Built-in tools plus this run's external (MCP) tools. */
  readonly all: ToolDef[];
  private byName: Map<string, ToolDef>;

  constructor(external: ToolDef[] = []) {
    this.all = [...ALL_TOOLS, ...external.filter((t) => !ALL_TOOLS.some((b) => b.name === t.name))];
    this.byName = new Map(this.all.map((t) => [t.name, t]));
  }

  /** Tools offered this step: mode decides read-only vs all; the edit-format policy decides which edit tools; optional groups only when the todo needs them. */
  enabled(mode: AgentMode, ctx: ToolContext): ToolDef[] {
    const edit = new Set<string>(enabledEditTools(ctx.profile, ctx.edits));
    return this.all.filter((t) => {
      if (t.group === "mcp") {
        if (!ctx.mcpTools?.has(t.name)) return false;
      } else if (t.group && !(t.group === "symbols" ? ctx.largeFiles : ctx.needs?.has(t.group))) return false;
      if (t.available && !t.available(ctx)) return false;
      if (mode !== "agent" && (t.kind === "write" || t.kind === "exec")) return false;
      if (t.name === "done") return mode !== "ask";
      if (t.name === "answer") return mode === "ask";
      if (["edit", "rewrite_file", "edit_lines"].includes(t.name)) return edit.has(t.name);
      return true;
    });
  }

  /** JSON Schema for one action. One anyOf branch per enabled tool so args are constrained too. */
  actionSchema(tools: ToolDef[]): Schema {
    return {
      type: "object",
      properties: {
        thought: { type: "string", maxLength: THOUGHT_MAX, description: "One or two sentences: what you do next and why." },
        action: {
          anyOf: tools.map((t) => ({
            type: "object",
            properties: { tool: { const: t.name }, args: t.params },
            required: ["tool", "args"],
          })),
        },
      },
      required: ["thought", "action"],
    };
  }

  /** Parses the raw model reply into an Action: JSON (tolerates fences/wrapping) or the xml tool format. */
  parse(raw: string): { action: Action } | { error: string } {
    const xml = /<tool\s+name="([\w-]+)"\s*>([\s\S]*?)(?:<\/tool>|$)/.exec(raw);
    if (xml) {
      const thought = /<thought>([\s\S]*?)(?:<\/thought>|<tool)/.exec(raw)?.[1]?.trim() ?? raw.slice(0, xml.index).trim();
      const body = xml[2].trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      let args: unknown = {};
      if (body) {
        try {
          args = JSON.parse(body);
        } catch {
          return { error: `Arguments of <tool name="${xml[1]}"> are not valid JSON.` };
        }
      }
      return { action: { thought, tool: xml[1], args: (args ?? {}) as Record<string, unknown> } };
    }
    // Attribute style models improvise: <edit path="a.js" search="..." replace="..."/>
    const attr = /<([a-z_]+)((?:\s+[a-z_]+="(?:[^"\\]|\\.)*")+)\s*\/?>/.exec(raw);
    if (attr && this.byName.has(attr[1])) {
      const args: Record<string, unknown> = {};
      for (const m of attr[2].matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) {
        const v = m[2].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1");
        args[m[1]] = /^\d+$/.test(v) && /line/.test(m[1]) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
      }
      const thought = /<thought>([\s\S]*?)<\/thought>/.exec(raw)?.[1]?.trim() ?? "";
      return { action: { thought, tool: attr[1], args } };
    }
    const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      const m = /\{[\s\S]*\}/.exec(text);
      try {
        obj = m ? JSON.parse(m[0]) : undefined;
      } catch {
        /* fall through */
      }
    }
    if (!obj || typeof obj !== "object") return { error: "Reply was not valid JSON." };
    const act = obj.action ?? obj;
    // Also accept the function-call shape models emit as text: {"name": ..., "arguments": ...}.
    const tool = act.tool ?? act.name;
    if (typeof tool !== "string") return { error: "Reply has no action.tool." };
    // Native-style replies put the reasoning as plain text before the JSON.
    const before = text.slice(0, text.indexOf("{")).trim();
    return { action: { thought: String(obj.thought ?? before), tool, args: act.args ?? act.arguments ?? {} } };
  }

  /** Schema + path + semantic validation. Errors are phrased for the model to fix. */
  async check(action: Action, enabled: ToolDef[], ctx: ToolContext): Promise<Checked> {
    const tool = this.byName.get(action.tool);
    if (!tool) return { ok: false, error: `Unknown tool "${action.tool}". Available: ${enabled.map((t) => t.name).join(", ")}.` };
    if (!enabled.includes(tool)) return { ok: false, error: `Tool "${action.tool}" is not available now. Available: ${enabled.map((t) => t.name).join(", ")}.` };
    const errors = validate(action.args, tool.params);
    if (errors.length) return { ok: false, error: `Invalid arguments for ${tool.name}: ${errors.join("; ")}.` };

    const args: Record<string, unknown> = { ...action.args };
    if (typeof args.path === "string") {
      const r = resolveWorkspacePath(ctx.host.root, args.path);
      if ("error" in r) return { ok: false, error: r.error };
      if (tool.kind === "write" && writeForbidden(r.path)) return { ok: false, error: `Writing to ${r.path} is not allowed.` };
      args.path = r.path;
    }
    // Read before edit (as in Claude Code): models guess the lines of files they haven't seen.
    // A generator's boilerplate (vite's App.vue) replaced as a whole needs no reading first.
    const generated = tool.name === "rewrite_file" && typeof args.path === "string" && ctx.generated?.has(args.path);
    if (ctx.seen && EDITS_EXISTING.has(tool.name) && !generated && typeof args.path === "string" && !ctx.seen.has(args.path) && (await ctx.host.stat(args.path)) === "file") {
      return { ok: false, policy: true, error: `You haven't read ${args.path} in this task. Read it first (read_file), then change it using its exact lines.` };
    }
    // "Move a.py to pkg/b.py": creating the target by hand leaves the old file and every import of it behind.
    if ((tool.name === "create_file" || tool.name === "rewrite_file") && typeof args.path === "string" && (await ctx.host.stat(args.path)) === null) {
      const from = await movedFrom(args.path, ctx);
      if (from) {
        return {
          ok: false,
          policy: true,
          error: `The user asked to move ${from} to ${args.path}: use move_file with from "${from}" and to "${args.path}". It moves the file and updates every import of it; writing ${args.path} by hand leaves ${from} and the old imports behind.`,
        };
      }
    }
    // Code moving into a new file: read where it comes from first. Models wrote the new file from the
    // task's words (a tax formula lost its rounding) or as stubs.
    if (ctx.seen && tool.kind === "write" && typeof args.path === "string" && (await ctx.host.stat(args.path)) === null) {
      const sources = await unreadSources(args.path, ctx);
      if (sources.length) {
        return { ok: false, policy: true, error: `Read the code that moves into ${args.path} first (read_file ${sources.join(" or ")}), then copy it exactly: formulas, rounding and messages, not a version written from the task's description.` };
      }
    }
    // "The tests fail, fix it": existing tests stay as they are (see agent/testGuard.ts).
    const target = typeof args.path === "string" ? args.path : typeof args.from === "string" ? args.from : undefined;
    if (ctx.protectTests && tool.kind === "write" && tool.name !== "create_file" && target && isTestFile(target) && (await ctx.host.stat(target)) === "file") {
      return { ok: false, policy: true, error: `${target} ${TESTS_PROTECTED}` };
    }
    // New tests nobody asked for (updating existing ones, e.g. in a rename, stays allowed).
    if (ctx.message !== undefined && !asksForTests(ctx.message) && tool.kind === "write" && target && isTestFile(target) && (await addedTests(tool.name, args, ctx)) > 0) {
      return { ok: false, policy: true, error: `${target}: ${NO_NEW_TESTS}` };
    }
    const semantic = await tool.check?.(args, ctx);
    if (semantic) return { ok: false, error: semantic };
    return { ok: true, tool, args };
  }

  /** An action rendered the way the given tool mode writes it, for the conversation history. */
  render(action: Action, mode: "schema" | "native" | "xml"): string {
    if (mode === "xml") return `<thought>${action.thought}</thought>\n<tool name="${action.tool}">${JSON.stringify(action.args)}</tool>`;
    if (mode === "native") return (action.thought ? action.thought + "\n" : "") + JSON.stringify({ name: action.tool, arguments: action.args });
    return JSON.stringify({ thought: action.thought, action: { tool: action.tool, args: action.args } });
  }

  /** Tool definitions for native function calling. */
  toolSpecs(tools: ToolDef[]) {
    return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.params }));
  }

  describe(tools: ToolDef[]): string {
    return tools
      .map((t) => {
        const props = t.params.properties ?? {};
        const req = new Set(t.params.required ?? []);
        const sig = Object.entries(props).map(([k, s]) => `${k}${req.has(k) ? "" : "?"}: ${typeName(s)}`).join(", ");
        // Built-in tools explain their arguments in the description; external ones may describe each argument.
        const notes = Object.entries(props).filter(([, s]) => s.description).map(([k, s]) => `${k}: ${s.description}`);
        return `- ${t.name}(${sig}): ${t.description}${notes.length ? ` (${notes.join("; ")})` : ""}`;
      })
      .join("\n");
  }
}

function typeName(s: Schema): string {
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join("|");
  if (s.anyOf) return [...new Set(s.anyOf.map(typeName))].join("|");
  if (s.type === "array") return `${s.items ? typeName(s.items) : "any"}[]`;
  return s.type ?? "any";
}
