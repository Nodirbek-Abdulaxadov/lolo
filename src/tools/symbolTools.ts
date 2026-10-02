import { spawn } from "node:child_process";
import { findSymbols } from "../context/mentions";
import { commentOccurrences, fileSymbols, identifierOccurrences, languageFor } from "../context/treeSitter";
import type { FileChange, SourcePos } from "../host/types";
import { IGNORED_DIRS } from "./paths";
import { findRg, search } from "./search";
import { fail, ok, ToolContext, ToolDef } from "./types";

/**
 * Symbol tools: the language server when the host has one (VS Code), tree-sitter
 * otherwise. A rename done by code is far more reliable than a small model editing
 * every file by hand.
 */

const MAX_REFS = 60;
const DEF_LINES = 40;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** "Cart.total" → name "total", parent "Cart". */
function splitSymbol(symbol: string): { name: string; parent?: string } {
  const parts = symbol.split(/[.:#]+/).filter(Boolean);
  return { name: parts[parts.length - 1] ?? symbol, parent: parts[parts.length - 2] };
}

/** Workspace files that contain `word` as a whole word (ripgrep). */
export function filesWithWord(ctx: ToolContext, word: string): Promise<string[]> {
  const args = ["-l", "-w", "-F", "--color=never", "--path-separator=/"];
  for (const d of IGNORED_DIRS) args.push("--glob", `!${d}/`);
  args.push("--", word, ".");
  return new Promise((resolve) => {
    const p = spawn(findRg(ctx.host.rgPath?.()), args, { cwd: ctx.host.root, signal: ctx.signal });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve([]));
    p.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => l.replace(/\\/g, "/").replace(/^\.\//, "")).sort()));
  });
}

interface Definition {
  path: string;
  line: number;
  endLine: number;
  pos: SourcePos;
}

/** Definitions of `symbol`: in `path` when given, else anywhere (LSP workspace symbols, then tree-sitter). */
async function definitions(ctx: ToolContext, symbol: string, path?: string): Promise<Definition[]> {
  const { name, parent } = splitSymbol(symbol);
  const files = path ? [path] : [];
  if (!path) {
    const locs = (ctx.host.workspaceSymbols ? await ctx.host.workspaceSymbols(name) : []).filter((l) => l.name === name);
    const found = locs.length ? locs : await findSymbols(ctx.host, name);
    files.push(...new Set(found.map((l) => l.path)));
  }
  const out: Definition[] = [];
  for (const f of files) {
    const text = await ctx.host.readFile(f).catch(() => undefined);
    if (text === undefined) continue;
    const defs = (await fileSymbols(f, text))?.defs ?? [];
    const occ = (await identifierOccurrences(f, text, name)) ?? [];
    for (const d of defs) {
      if (d.name !== name) continue;
      if (parent && !defs.some((p) => p !== d && p.name === parent && p.line <= d.line && p.endLine >= d.endLine)) continue;
      const at = occ.find((o) => o.line >= d.line && o.line <= d.endLine);
      if (at) out.push({ path: f, line: d.line, endLine: d.endLine, pos: { path: f, line: at.line, column: at.column } });
    }
  }
  return out;
}

/** Where to point the language server: the definition, else the first occurrence in `path`. */
async function anchor(ctx: ToolContext, symbol: string, path?: string): Promise<SourcePos | undefined> {
  const def = (await definitions(ctx, symbol, path))[0];
  if (def) return def.pos;
  if (!path) return undefined;
  const text = await ctx.host.readFile(path).catch(() => "");
  const o = (await identifierOccurrences(path, text, splitSymbol(symbol).name))?.[0];
  return o && { path, line: o.line, column: o.column };
}

/** Occurrences as identifiers (not in strings/comments) across the workspace, by tree-sitter. */
async function occurrences(ctx: ToolContext, name: string): Promise<{ found: SourcePos[]; textOnly: string[] }> {
  const found: SourcePos[] = [];
  const textOnly: string[] = [];
  for (const f of await filesWithWord(ctx, name)) {
    const text = await ctx.host.readFile(f).catch(() => undefined);
    if (text === undefined) continue;
    const occ = await identifierOccurrences(f, text, name);
    if (!occ?.length) {
      textOnly.push(f);
      continue;
    }
    for (const o of occ) found.push({ path: f, line: o.line, column: o.column });
  }
  return { found, textOnly };
}

async function lineText(ctx: ToolContext, cache: Map<string, string[]>, p: SourcePos): Promise<string> {
  if (!cache.has(p.path)) cache.set(p.path, (await ctx.host.readFile(p.path).catch(() => "")).replace(/\r\n/g, "\n").split("\n"));
  return (cache.get(p.path)![p.line - 1] ?? "").trim().slice(0, 160);
}

async function mustBeCodeFile(path: string | undefined, ctx: ToolContext): Promise<string | undefined> {
  if (!path) return undefined;
  if ((await ctx.host.stat(path)) !== "file") return `"${path}" is not a file in the workspace.`;
  return languageFor(path) || ctx.host.references ? undefined : `${path} has no supported language; use search instead.`;
}

export const findDefinition: ToolDef<{ symbol: string }> = {
  name: "find_definition",
  kind: "read",
  group: "refactor",
  description: "Find where a function, class or method is defined (`symbol`, or `Class.method`) and show its code.",
  params: { type: "object", properties: { symbol: { type: "string", minLength: 1 } }, required: ["symbol"] },
  async run(a, ctx) {
    const defs = await definitions(ctx, a.symbol);
    if (!defs.length) return fail(`No definition of "${a.symbol}" found. Try search with the name.`, `find_definition ${a.symbol}: not found`);
    const blocks: string[] = [];
    for (const d of defs.slice(0, 3)) {
      const lines = (await ctx.host.readFile(d.path)).replace(/\r\n/g, "\n").split("\n");
      const end = Math.min(d.endLine, d.line + DEF_LINES - 1);
      const cut = end < d.endLine ? `\n[${d.endLine - end} more lines; read_file ${d.path} start_line=${end + 1}]` : "";
      blocks.push(`${d.path} lines ${d.line}-${d.endLine}:\n${lines.slice(d.line - 1, end).join("\n")}${cut}`);
    }
    const more = defs.length > 3 ? `\n[${defs.length - 3} more definitions with this name]` : "";
    return ok(blocks.join("\n\n") + more, `find_definition ${a.symbol}: ${defs.map((d) => `${d.path}:${d.line}`).join(", ")}`);
  },
};

export const findReferences: ToolDef<{ symbol: string; path?: string }> = {
  name: "find_references",
  kind: "read",
  group: "refactor",
  description: "List every place a symbol is used (code only, not strings or comments). Optional `path`: a file that defines or uses it, when the name is ambiguous.",
  params: { type: "object", properties: { symbol: { type: "string", minLength: 1 }, path: { type: "string" } }, required: ["symbol"] },
  check: (a, ctx) => mustBeCodeFile(a.path, ctx),
  async run(a, ctx) {
    const { name } = splitSymbol(a.symbol);
    const at = ctx.host.references ? await anchor(ctx, a.symbol, a.path) : undefined;
    let refs = at ? await ctx.host.references!(at) : undefined;
    let note = "";
    if (!refs) {
      const occ = await occurrences(ctx, name);
      refs = occ.found;
      note = "\n[Matched by name: unrelated symbols with the same name are included.]";
      if (occ.textOnly.length) note += `\n[Also mentioned as text in: ${occ.textOnly.slice(0, 10).join(", ")}]`;
    }
    if (!refs.length) return ok(`No references to "${a.symbol}".`, `find_references ${a.symbol}: none`);
    const cache = new Map<string, string[]>();
    const lines: string[] = [];
    for (const r of refs.slice(0, MAX_REFS)) lines.push(`${r.path}:${r.line}: ${await lineText(ctx, cache, r)}`);
    const files = new Set(refs.map((r) => r.path));
    const more = refs.length > MAX_REFS ? `\n[${refs.length - MAX_REFS} more]` : "";
    return ok(lines.join("\n") + more + note, `find_references ${a.symbol}: ${refs.length} in ${files.size} files`);
  },
};

export const renameSymbol: ToolDef<{ symbol: string; new_name: string; path?: string }> = {
  name: "rename_symbol",
  kind: "write",
  group: "refactor",
  description:
    "Rename a function, class, method or variable everywhere it is used (definition, imports, exports, calls) in one step. " +
    "Optional `path`: the file that defines it, when the name is ambiguous.",
  params: {
    type: "object",
    properties: { symbol: { type: "string", minLength: 1 }, new_name: { type: "string", minLength: 1 }, path: { type: "string" } },
    required: ["symbol", "new_name"],
  },
  async check(a, ctx) {
    const { name } = splitSymbol(a.symbol);
    if (!IDENT.test(a.new_name)) return `new_name "${a.new_name}" is not a valid identifier.`;
    if (a.new_name === name) return "new_name is the same as the current name.";
    return mustBeCodeFile(a.path, ctx);
  },
  async run(a, ctx) {
    const { name } = splitSymbol(a.symbol);
    let changes: FileChange[] | undefined;
    let via = "language server";
    if (ctx.host.renameEdits) {
      const at = await anchor(ctx, a.symbol, a.path);
      if (at) changes = await ctx.host.renameEdits(at, a.new_name);
    }
    if (!changes) {
      via = "name match";
      const occ = await occurrences(ctx, name);
      const byFile = new Map<string, SourcePos[]>();
      for (const o of occ.found) byFile.set(o.path, [...(byFile.get(o.path) ?? []), o]);
      changes = [];
      for (const [f] of byFile) {
        const text = await ctx.host.readFile(f);
        const occs = (await identifierOccurrences(f, text, name)) ?? [];
        let out = text;
        for (const o of [...occs].reverse()) out = out.slice(0, o.start) + a.new_name + out.slice(o.end);
        changes.push({ path: f, content: out });
      }
    }
    if (!changes.length) return fail(`"${name}" was not found in any code file. Check the name with search.`, `rename_symbol ${name}: not found`);
    // Comments in the renamed files ("// ParseCSV parses ...") name the symbol when the name is code-like
    // (camelCase, PascalCase with an inner capital, snake_case, digits); a plain word ("Basket") may be prose.
    let inComments = 0;
    if (name.length >= 4 && /[a-z][A-Z]|[A-Za-z]_[A-Za-z]|[A-Za-z]\d/.test(name)) {
      for (const c of changes) {
        const occs = (await commentOccurrences(c.path, c.content, name)) ?? [];
        for (const o of [...occs].reverse()) c.content = c.content.slice(0, o.start) + a.new_name + c.content.slice(o.end);
        inComments += occs.length;
      }
    }
    // Renaming onto an existing name would silently merge two symbols.
    for (const c of changes) {
      const before = await ctx.host.readFile(c.path).catch(() => "");
      if ((await identifierOccurrences(c.path, before, a.new_name))?.length) {
        return fail(`"${a.new_name}" is already used in ${c.path}; pick another name or edit by hand.`, `rename_symbol ${name}: name clash`);
      }
    }
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const counts = await Promise.all(
      changes.map(async (c) => {
        const before = await ctx.host.readFile(c.path).catch(() => "");
        return `${c.path} (${(before.match(word) ?? []).length - (c.content.match(word) ?? []).length})`;
      }),
    );
    const r = await ctx.host.proposeWrites(changes, `rename ${name} → ${a.new_name}`);
    if (!r.applied) {
      const said = r.note ? ` They said: ${r.note}` : "";
      return fail(`The user rejected the rename.${said}`, `rename_symbol ${name}: rejected`);
    }
    (ctx.renamed ??= new Map()).set(name, a.new_name);
    // Strings, comments and files without a grammar are not renamed: tell the model where the old name remains.
    const left = await search.run({ query: `\\b${name.replace(/\$/g, "\\$")}\\b`, regex: true }, ctx);
    const remaining = left.ok && !left.output.startsWith("No matches")
      ? `\n"${name}" still appears as text (strings, comments or files without a grammar); update these by hand if they should change:\n${left.output.split("\n").slice(0, 15).join("\n")}`
      : "";
    const comments = inComments ? ` Comments that named it were updated too (${inComments}).` : "";
    return ok(
      `Renamed ${name} to ${a.new_name} (${via}) in ${changes.length} file(s): ${counts.join(", ")}.${comments}${remaining}`,
      `rename_symbol ${name} → ${a.new_name}: ${changes.length} files`,
      changes.map((c) => c.path),
    );
  },
};

/** Whether `name` still occurs as an identifier in any code file. */
export async function codeStillUses(ctx: ToolContext, name: string): Promise<boolean> {
  return (await occurrences(ctx, name)).found.length > 0;
}
