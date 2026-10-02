import { listFiles } from "../context/repoMap";
import { codeWithoutComments, fileSymbols, languageFor } from "../context/treeSitter";
import { restoreCopiedEscapes } from "../edit/escapes";
import { applyLineRange, editToolFor, EditState, EditTool, isLazyPlaceholder, isStub, mergeLazyRewrite, widenForReassignment } from "../edit/formats";
import { blockCandidates, fuzzyApply, overlapCandidates, reindent, retypedTail } from "../edit/fuzzyApply";
import { jsRuntimeProblem } from "../edit/jsChecks";
import { pyRuntimeProblem } from "../edit/pyChecks";
import { checkEditSyntax, findImbalance, fixCSharpEscapes, syntaxRepairs } from "../edit/syntaxGuard";
import { collapseBlankRuns, detectEol, fromLf, maxBlankRun, numberLines, toLf } from "../edit/text";
import { unusedImportNote } from "../edit/unusedImports";
import { exportShapeProblem, moduleSystemMismatch, moduleSystemProblem, toCommonJs, undefinedExports } from "./moduleSystem";
import { committedVersion } from "./gitTools";
import { placeholderNamespaceFix } from "./missingImports";
import { IGNORED_DIRS } from "./paths";
import { symbolSummary } from "./output";
import { fail, ok, ToolContext, ToolDef, ToolResult } from "./types";

const MAX_READ_LINES = 400;

/**
 * A package added by editing the project file: models guess versions (EF Core 9 in a .NET 10
 * project), while the package manager picks the one that fits. Returns advice, or undefined.
 */
export function handAddedPackage(path: string, before: string, after: string): string | undefined {
  if (/\.(cs|fs|vb)proj$/.test(path)) {
    const refs = (t: string) => new Set([...t.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)].map((m) => m[1].toLowerCase()));
    const old = refs(before);
    const added = [...after.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)].map((m) => m[1]).filter((n) => !old.has(n.toLowerCase()));
    if (added.length) {
      const dir = path.split("/").slice(0, -1).join("/") || ".";
      return `Don't add NuGet packages by editing ${path}: run \`dotnet add package ${added[0]}\` with cwd "${dir}" (one command per package). It picks the version that matches the project's .NET version. The file was NOT changed.`;
    }
  }
  if (path === "package.json" || path.endsWith("/package.json")) {
    const deps = (t: string) => {
      try {
        const j = JSON.parse(t);
        return { ...j.dependencies, ...j.devDependencies } as Record<string, string>;
      } catch {
        return undefined;
      }
    };
    const was = deps(before);
    const now = deps(after);
    const added = was && now ? Object.keys(now).filter((n) => !(n in was)) : [];
    if (added.length) {
      const dir = path.split("/").slice(0, -1).join("/") || ".";
      return `Don't add packages by editing ${path}: run \`npm install ${added.join(" ")}\` (add -D for dev tools) with cwd "${dir}". It installs them and records a version that exists. The file was NOT changed.`;
    }
  }
  return undefined;
}

/** Files a project has exactly one of: a second Program.cs means two sets of top-level statements (CS8802). */
const ONE_PER_PROJECT = /^(Program\.cs|Startup\.cs|appsettings\.json|package\.json|tsconfig\.json|go\.mod|pyproject\.toml|Cargo\.toml|manage\.py)$/;
const PROJECT_FILE = /(\.csproj|\.fsproj|^package\.json|^go\.mod|^pyproject\.toml|^Cargo\.toml)$/;

/** An existing file with the same one-per-project name in the project `path` would belong to. */
async function projectTwin(path: string, ctx: ToolContext): Promise<string | undefined> {
  const name = path.split("/").pop()!;
  if (!ONE_PER_PROJECT.test(name)) return undefined;
  const files = await listFiles(ctx.host);
  const dirs = new Set(files.filter((f) => PROJECT_FILE.test(f.split("/").pop()!)).map((f) => f.split("/").slice(0, -1).join("/")));
  const projectOf = (p: string) => {
    const parts = p.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) if (dirs.has(parts.slice(0, i).join("/"))) return parts.slice(0, i).join("/");
    return undefined;
  };
  const project = projectOf(path);
  if (project === undefined) return undefined;
  return files.find((f) => f !== path && f.split("/").pop() === name && projectOf(f) === project);
}

const EDIT_HINT: Record<EditTool, string> = {
  rewrite_file: "rewrite_file with the complete new content",
  edit: "edit (search/replace)",
  edit_lines: "edit_lines with the line numbers shown",
};

/** Keeps the original EOL style, trailing newline and blank-line spacing; models drift on all three. */
function matchFileEnding(before: string, after: string): string {
  const eol = detectEol(before);
  const lf = collapseBlankRuns(toLf(after), Math.max(2, maxBlankRun(before)));
  let out = fromLf(lf, eol);
  if (before.endsWith(eol) && !out.endsWith(eol)) out += eol;
  return out;
}

/**
 * Hard format constraints only: rewrite_file is limited to small files (output size),
 * edit_lines needs a numbered view. `edit` is always allowed; read_file recommends
 * the best tool per file, and the syntax guard catches broken splices.
 */
async function mustUse(tool: EditTool, path: string, ctx: ToolContext): Promise<string | undefined> {
  if (tool === "edit") return undefined;
  const lines = toLf(await ctx.host.readFile(path)).split("\n").length;
  const want = editToolFor(ctx.profile, ctx.edits, path, lines);
  if (tool === "rewrite_file" && ctx.profile.editFormat !== "whole" && lines > ctx.profile.wholeFileMaxLines) {
    return `${path} has ${lines} lines, too many for rewrite_file (max ${ctx.profile.wholeFileMaxLines}). Use ${EDIT_HINT[want]}.`;
  }
  if (tool === "edit_lines" && want !== "edit_lines") return `edit_lines needs a numbered view of the file. Use ${EDIT_HINT[want]} for ${path}.`;
  return undefined;
}

/** Existing files with the same name as `path` (plans guess folders before generators have run). */
async function sameName(path: string, ctx: ToolContext): Promise<string[]> {
  const name = path.split("/").pop()!;
  return (await listFiles(ctx.host)).filter((f) => f !== path && f.split("/").pop() === name).slice(0, 5);
}

async function mustBeFile(path: string, ctx: ToolContext): Promise<string | undefined> {
  const kind = await ctx.host.stat(path);
  if (kind === null) {
    const same = await sameName(path, ctx);
    if (same.length) return `File "${path}" does not exist, but ${same.join(", ")} does. Use that path: the plan guessed the folder.`;
    return `File "${path}" does not exist. To create it, use create_file (it creates missing folders); to find an existing file, use list_dir or search.`;
  }
  if (kind === "dir") return `"${path}" is a directory. Use list_dir.`;
  return undefined;
}

/** `.env`, `.env.local`, `prod.env` (not `.env.example`): secrets that must not reach the model or the logs. */
export function isSecretsFile(path: string): boolean {
  const name = path.split("/").pop()!;
  return /^\.env(\.[\w-]+)?$|\.env$/.test(name) && !/example|sample|template|dist/i.test(name);
}

/** Variable names with their values hidden: the model needs the names, the shell or a script reads the values. */
export function maskSecrets(path: string, text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => {
    const m = /^(\s*(?:export\s+)?[\w.]+\s*=)\s*(.*)$/.exec(l);
    if (!m) return l;
    const v = m[2].replace(/^["']|["']$/g, "");
    return `${m[1]}<${v ? `set, ${v.length} chars` : "empty"}>`;
  });
  return (
    `${path} (values hidden; they are secrets):\n${lines.join("\n")}\n` +
    "[Use the variables without reading their values: in a Python script, parse this file and use the values directly; in a shell command, load it first with `set -a && . ./.env && set +a`.]"
  );
}

export const readFile: ToolDef<{ path: string; start_line?: number; end_line?: number }> = {
  name: "read_file",
  kind: "read",
  description: `Read a file. Optional start_line/end_line (1-based) for a range; at most ${MAX_READ_LINES} lines are returned.`,
  params: {
    type: "object",
    properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
    required: ["path"],
  },
  check: (a, ctx) => mustBeFile(a.path, ctx),
  async run(a, ctx) {
    const raw = await ctx.host.readFile(a.path);
    if (isSecretsFile(a.path)) return ok(maskSecrets(a.path, raw), `read_file ${a.path}: ${raw.split("\n").filter((l) => /^\s*[\w.]+\s*=/.test(l)).length} variables (values hidden)`);
    // An empty file shown as just the edit hint made models copy the hint into `search`.
    if (!raw.trim()) {
      const how = ctx.readOnly ? "" : ` To fill it, use rewrite_file with the complete content.`;
      return ok(`${a.path} is empty (no content yet).${how}`, `read_file ${a.path}: empty`);
    }
    const lines = toLf(raw).split("\n");
    const start = Math.min(a.start_line ?? 1, lines.length);
    const end = Math.min(a.end_line ?? lines.length, lines.length, start + MAX_READ_LINES - 1);
    const slice = lines.slice(start - 1, end);
    // Line numbers only once the file is in line-range mode; otherwise models copy them into `search`.
    const body = ctx.edits.isLineRange(a.path) ? numberLines(slice, start) : slice.join("\n");
    const range = start === 1 && end === lines.length ? `${lines.length} lines` : `lines ${start}-${end} of ${lines.length}`;
    const more = end < lines.length ? `\n[${lines.length - end} more lines; read again with start_line=${end + 1}]` : "";
    const symbols = symbolSummary(slice.join("\n"));
    const big = lines.length > ctx.profile.wholeFileMaxLines && !!languageFor(a.path);
    if (big) ctx.largeFiles = true;
    const tip = big ? `\n[Big file: read_symbol reads just one function or class by name.]` : "";
    const hint = ctx.readOnly ? "" : `\n[To change this file use ${EDIT_HINT[editToolFor(ctx.profile, ctx.edits, a.path, lines.length)]}.]`;
    return ok(`${a.path} (${range}):\n${body}${more}${hint}${tip}`, `read_file ${a.path}: ${range}${symbols ? `; ${symbols}` : ""}`);
  },
};

export const readSymbol: ToolDef<{ path: string; symbol: string }> = {
  name: "read_symbol",
  kind: "read",
  group: "symbols",
  description: "Read only one function, method or class of a big file by name (`symbol`, or `Class.method`). Small files are returned whole.",
  params: { type: "object", properties: { path: { type: "string" }, symbol: { type: "string", minLength: 1 } }, required: ["path", "symbol"] },
  async check(a, ctx) {
    const bad = await mustBeFile(a.path, ctx);
    if (bad) return bad;
    return languageFor(a.path) ? undefined : `read_symbol does not support ${a.path}. Use read_file with start_line/end_line.`;
  },
  async run(a, ctx) {
    const raw = await ctx.host.readFile(a.path);
    // A partial view of a small file made the model rewrite_file it and drop the unseen parts (module.exports).
    if (toLf(raw).split("\n").length <= ctx.profile.wholeFileMaxLines) return readFile.run({ path: a.path }, ctx);
    const defs = (await fileSymbols(a.path, raw))?.defs ?? [];
    const parts = a.symbol.split(/[.:#]+/).filter(Boolean);
    const name = parts[parts.length - 1] ?? a.symbol;
    const parent = parts[parts.length - 2];
    const found = defs.filter(
      (d) => d.name === name && (!parent || defs.some((p) => p !== d && p.name === parent && p.line <= d.line && p.endLine >= d.endLine)),
    );
    if (!found.length) {
      const names = [...new Set(defs.map((d) => d.name))].slice(0, 25).join(", ");
      return fail(`No symbol "${a.symbol}" in ${a.path}.${names ? ` Symbols here: ${names}.` : " No symbols found; use read_file."}`, `read_symbol ${a.path}#${a.symbol}: not found`);
    }
    const lines = toLf(raw).split("\n");
    const numbered = ctx.edits.isLineRange(a.path);
    const blocks = found.slice(0, 3).map((d) => {
      const end = Math.min(d.endLine, d.line + MAX_READ_LINES - 1);
      const slice = lines.slice(d.line - 1, end);
      const cut = end < d.endLine ? `\n[${d.endLine - end} more lines; use read_file with start_line=${end + 1}]` : "";
      return `${a.path} lines ${d.line}-${d.endLine} (${d.name}):\n${numbered ? numberLines(slice, d.line) : slice.join("\n")}${cut}`;
    });
    const extra = found.length > 3 ? `\n[${found.length - 3} more matches; qualify the name as Class.method]` : "";
    const hint = ctx.readOnly ? "" : `\n[To change this file use ${EDIT_HINT[editToolFor(ctx.profile, ctx.edits, a.path, lines.length)]}.]`;
    return ok(blocks.join("\n\n") + extra + hint, `read_symbol ${a.path}#${a.symbol}: lines ${found[0].line}-${found[0].endLine}`);
  },
};

export const listDir: ToolDef<{ path?: string }> = {
  name: "list_dir",
  kind: "read",
  description: "List a directory (default: workspace root). Directories end with /.",
  params: { type: "object", properties: { path: { type: "string" } } },
  async check(a, ctx) {
    const kind = await ctx.host.stat(a.path ?? ".");
    if (kind === "dir") return undefined;
    return kind === "file" ? `"${a.path}" is a file, not a folder. Use read_file.` : `Folder "${a.path}" does not exist. create_file creates missing folders.`;
  },
  async run(a, ctx) {
    const dir = a.path ?? ".";
    const entries = (await ctx.host.listDir(dir))
      .filter((e) => !(e.type === "dir" && IGNORED_DIRS.has(e.name)))
      .sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === "dir" ? -1 : 1));
    const shown = entries.slice(0, 200).map((e) => e.name + (e.type === "dir" ? "/" : ""));
    const more = entries.length > shown.length ? `\n[${entries.length - shown.length} more]` : "";
    return ok(`${dir}/:\n${shown.join("\n") || "(empty)"}${more}`, `list_dir ${dir}: ${entries.length} entries`);
  },
};

/**
 * Line breaks the model escaped twice in its JSON (`"pop() {\\n    return x;\\n}"`): the text
 * then holds `\n` as two characters and nothing matches or parses. Only for text without a
 * real line break and several `\n` before indentation or a bracket (not a `"\n"` in a string).
 */
export function doubleEscaped(s: string): boolean {
  return !s.includes("\n") && (s.match(/\\n(?=[ \t}\])]|\\n|$)/g) ?? []).length >= 2;
}

const unescapeBreaks = (s: string) => s.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
const escaped = new WeakSet<object>();

/** `content` escaped twice: fixed in place (checks run before run()). */
function fixEscapes(a: { content: string }) {
  if (!doubleEscaped(a.content)) return;
  a.content = unescapeBreaks(a.content);
  escaped.add(a);
}

const converted = new WeakSet<object>();
const escapeNote = (a: object) => (escaped.has(a) ? ESCAPE_NOTE : "") + (converted.has(a) ? CONVERTED_NOTE : "");
const ESCAPE_NOTE = " (your line breaks were escaped twice as \\\\n; they were turned into real line breaks)";
const CONVERTED_NOTE = " (this project uses CommonJS, so export/import were turned into module.exports/require; use require to load it)";

/**
 * The module-system check for a whole file (create_file, rewrite_file): export/import in a CommonJS
 * project is converted by code when the file uses only plain forms, instead of refused.
 */
async function wholeFileModules(a: { path: string; content: string }, before: string, ctx: ToolContext): Promise<string | undefined> {
  const mismatch = await moduleSystemMismatch(a.path, a.content, before, ctx);
  if (!mismatch) return undefined;
  const cjs = mismatch.wants === "commonjs" ? toCommonJs(a.content) : undefined;
  if (!cjs) return mismatch.advice;
  a.content = cjs;
  converted.add(a);
  return undefined;
}

/**
 * A `// existing implementation` / `// ... rest of the code` line that `before` doesn't have:
 * in new code it is a hole, not code (a moved function written as a stub). Error text, or undefined.
 */
function placeholderIn(text: string, before: string, path: string, todo?: string): string | undefined {
  if (!languageFor(path) && !BRACE_FILE.test(path)) return undefined;
  const known = new Set(toLf(before).split("\n").map((l) => l.trim()));
  const hole = toLf(text).split("\n").find((l) => isLazyPlaceholder(l, known));
  return hole ? holeError(hole, before) : stubIn(text, before, path, todo);
}

const WANTS_STUBS = /\b(?:[Ss]tubs?|[Ss]keletons?|[Ss]caffold\w*|[Pp]laceholders?)\b|\bTODOs?\b/;

/**
 * A body left out of new code (`{ ... }`, `// validation logic here` right after `{`): models write
 * the new file of a move or split before reading the code they move. Error text, or undefined.
 * "Existing code" placeholders are left to mergeLazyRewrite; a todo asking for stubs gets them.
 */
function stubIn(text: string, before: string, path: string, todo?: string): string | undefined {
  if ((!languageFor(path) && !BRACE_FILE.test(path)) || WANTS_STUBS.test(todo ?? "")) return undefined;
  const known = new Set(toLf(before).split("\n").map((l) => l.trim()));
  const lines = toLf(text).split("\n");
  const previous = (i: number) => lines.slice(0, i).reverse().find((p) => p.trim());
  const stub = lines.find((l, i) => !isLazyPlaceholder(l, known) && isStub(l, previous(i), known));
  return stub ? holeError(stub, before) : undefined;
}

const holeError = (line: string, before: string) =>
  `\`${line.trim()}\` is a placeholder, not code. Write the real code${before ? "" : " (read the file the code comes from, and copy it)"}; nothing may be left out.`;

/** A whole-file write to a path that doesn't exist (and isn't a misplaced existing file) creates it. */
async function createsFile(path: string, ctx: ToolContext): Promise<boolean> {
  return (await ctx.host.stat(path)) === null && !(await sameName(path, ctx)).length;
}

interface Def {
  name: string;
  line: number;
  endLine: number;
}

/** The innermost function/class around each line (tree-sitter); undefined outside any, or without a grammar. */
async function enclosingDefs(path: string, text: string, lines: number[]): Promise<(Def | undefined)[]> {
  const defs = (await fileSymbols(path, text))?.defs ?? [];
  return lines.map((l) => defs.filter((d) => d.line <= l && d.endLine >= l).sort((x, y) => x.endLine - x.line - (y.endLine - y.line))[0]);
}

/**
 * `search` ends with the first line(s) of a function or class (possibly after a few lines before
 * it: `let nextId = 1;` + `function createUser(...) {`) and `replace` holds a complete new version
 * of it (balanced brackets, same name): the model means to replace the whole definition. Applied
 * literally, the old body would stay behind as a dead `{ ... }` block, which still parses in JS.
 * Returns the file with everything from `search` to the definition's end replaced, when that
 * parses; lines after the definition that `replace` repeats at its end are not duplicated.
 * Brace languages only.
 */
async function redefinition(path: string, original: string, search: string, replace: string, startLine: number) {
  if (!BRACE_FILE.test(path)) return undefined;
  const lines = toLf(original).split("\n");
  const s = toLf(search).replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
  const r = toLf(replace).replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
  const searchEnd = startLine + s.split("\n").length - 1;
  // A definition that starts inside `search` and goes on after it (else `search` already spans it).
  const def = ((await fileSymbols(path, original))?.defs ?? []).find((d) => d.line >= startLine && d.line <= searchEnd && d.endLine > searchEnd);
  if (!def) return undefined;
  const rLines = r.split("\n");
  const nameRe = new RegExp(`(?<![\\w$])${def.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  const header = rLines.findIndex((l) => nameRe.test(l));
  if (header < 0 || header > def.line - startLine + 2 || !r.includes("{") || findImbalance(r)) return undefined;
  const body = reindent(r, [rLines[header]], [lines[def.line - 1]]);
  const after = lines.slice(def.endLine);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l.trim() === b[i].trim()) && a.some((l) => l.trim());
  let repeated = 0;
  for (let k = Math.min(rLines.length - header - 1, after.length); k > 0 && !repeated; k--) if (same(rLines.slice(-k), after.slice(0, k))) repeated = k;
  const content = fromLf([...lines.slice(0, startLine - 1), ...body, ...after.slice(repeated)].join("\n"), detectEol(original));
  if (await checkEditSyntax(path, original, content)) return undefined;
  return { content, name: def.name, from: def.line, to: def.endLine };
}

const RETYPED_NOTE = " (the end of your new text re-typed the lines after the ones you replaced, some changed; the old ones were replaced, not left below)";
const OVERLAP_NOTE = " (your new text repeated the lines next to the ones you replaced; they were replaced, not duplicated)";
const BLOCK_NOTE = " (you replaced only the first line of a block with a complete block, so it replaced the whole old block)";

const BRACE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|cs|java|kt|go|rs|c|h|cpp|hpp|cc|swift|php|dart|scala)$/i;

/** `fragment`: the text the model wrote for this edit (to spot a reply cut off by an unescaped quote). */
/** Lines of `before` and of the files the model read in this run: the code it may be copying. */
async function knownLines(ctx: ToolContext, before?: string): Promise<string[]> {
  const texts = before !== undefined ? [before] : [];
  for (const f of [...(ctx.seen ?? [])].slice(0, 30)) texts.push(await ctx.host.readFile(f).catch(() => ""));
  return texts.flatMap((t) => toLf(t).split("\n"));
}

const ESCAPES_RESTORED = " (regex escapes such as \\s that came out as line breaks were restored from the code you read; in JSON write them as \\\\s)";

/** The user asks to keep part of what is there ("fix the mistake but keep the rounding I added"). */
const KEEPS = /\b(keep(s|ing)?|preserv\w*|retain\w*)\b|\b(don'?t|do not|without)\s+(los\w*|remov\w*|drop\w*|undo\w*|revert\w*)\b/i;

/**
 * "My uncommitted change broke it; fix it but keep X": small models restore the committed file,
 * which passes the tests and throws away what the user asked to keep. Advice when `content` is the
 * committed version of a file that has uncommitted changes (comments and blank lines aside).
 */
async function undoesKeptChange(ctx: ToolContext, path: string, before: string, content: string): Promise<string | undefined> {
  const keep = KEEPS.exec(ctx.message ?? "");
  if (!keep) return undefined;
  const head = await committedVersion(path, ctx);
  const code = (t: string) => toLf(t).split("\n").map((l) => l.trim()).filter((l) => l && !/^(\/\/|#|\/\*|\*)/.test(l)).join("\n");
  if (head === undefined || code(head) === code(before) || code(head) !== code(content)) return undefined;
  const asked = ctx.message!.slice(Math.max(0, keep.index - 30), keep.index + 70).replace(/\s+/g, " ").trim();
  return (
    `This would restore the committed version of ${path} and undo all of the user's uncommitted change to it, but they asked to keep part of it ("…${asked}…"). ` +
    `Keep what they asked for and fix only the mistake in their change. The file was NOT changed.`
  );
}

/** Contents refused by a runtime check, per run. */
const runtimeRefused = new WeakMap<EditState, Set<string>>();
/** Whether the model proposes content a runtime check refused before: it insists, and the check may be wrong. */
function insists(ctx: ToolContext, path: string, content: string): boolean {
  const refused = runtimeRefused.get(ctx.edits) ?? new Set<string>();
  runtimeRefused.set(ctx.edits, refused);
  const key = `${path}\n${content}`;
  if (refused.has(key)) return true;
  refused.add(key);
  return false;
}

async function write(ctx: ToolContext, path: string, content: string, isNew: boolean, reason: string, note = "", fragment = content): Promise<ToolResult> {
  const before = isNew ? undefined : await ctx.host.readFile(path);
  const restored = restoreCopiedEscapes(content, await knownLines(ctx, before));
  if (restored.fixed) {
    content = restored.text;
    note += ESCAPES_RESTORED;
  }
  const csEscapes = await fixCSharpEscapes(path, content);
  if (csEscapes.fixed) {
    content = csEscapes.text;
    note += " (regex escapes such as \\s in normal C# strings were written as \\\\s: C# accepts only \\n, \\t, \\\\ and the like there)";
  }
  if (isNew && /\.cs$/i.test(path)) {
    const others = (await listFiles(ctx.host)).filter((f) => /\.cs$/i.test(f) && f !== path && !/(^|\/)(bin|obj)\//.test(f)).slice(0, 50);
    const ns = placeholderNamespaceFix(content, await Promise.all(others.map((f) => ctx.host.readFile(f).catch(() => ""))));
    if (ns) {
      content = ns.content;
      note += ` (\`namespace ${ns.from}\` is a placeholder; the project's code is in \`${ns.to}\`, so the file uses that)`;
    }
  }
  if (before !== undefined) content = matchFileEnding(before, content);
  if (content === before) {
    return {
      ...fail(`No change: ${path} already has exactly this content. If the current todo is complete, call done now; otherwise do the next step.`, `${reason}: no change`),
      noop: true,
    };
  }
  // Only comments changed ("// Ensure this matches the expected output" after a failing test): nothing the code does changed.
  if (before !== undefined && !/\b(comments?|doc\w*|jsdoc|docstrings?|annotat\w*|explain\w*|todo)\b/i.test(`${ctx.todo ?? ""} ${ctx.message ?? ""}`)) {
    const was = await codeWithoutComments(path, before);
    if (was !== undefined && was === (await codeWithoutComments(path, content))) {
      return {
        ...fail(`That change only touches comments: ${path} does exactly what it did before. If a check fails, the code itself must change; if the todo is complete, call done.`, `${reason}: comments only`),
        noop: true,
      };
    }
  }
  const pkg = before !== undefined ? handAddedPackage(path, before, content) : undefined;
  if (pkg) return fail(pkg, `${reason}: rejected (package added by hand)`);
  const missing = undefinedExports(path, content).filter((n) => !undefinedExports(path, before ?? "").includes(n));
  if (missing.length) {
    const what = missing.map((n) => `\`${n}\``).join(", ");
    return fail(`${path} would export ${what} without defining ${missing.length > 1 ? "them" : "it"}. Write the complete file: the code of ${what} (copied from where it was) and the export. The file was NOT changed.`, `${reason}: rejected (exports an undefined name)`);
  }
  const broken = await checkEditSyntax(path, before, content, fragment);
  if (broken) {
    let repaired: { text: string; note: string } | undefined;
    for (const r of syntaxRepairs(path, content)) if (!(await checkEditSyntax(path, before, r.text))) (repaired ??= r);
    if (!repaired) {
      ctx.edits.recordFailure(path);
      return fail(broken, `${reason}: rejected (syntax error)`);
    }
    content = repaired.text;
    note += ` (${repaired.note})`;
  }
  // Mistakes that parse but throw once the code runs, often where the tests don't look.
  const runtime =
    (await jsRuntimeProblem(path, before, content)) ??
    (await pyRuntimeProblem(path, before, content)) ??
    (before !== undefined ? await exportShapeProblem(path, before, content, ctx) : undefined);
  if (runtime && !insists(ctx, path, content)) return fail(runtime, `${reason}: rejected (would fail at runtime)`);
  const undone = before !== undefined ? await undoesKeptChange(ctx, path, before, content) : undefined;
  if (undone && !insists(ctx, path, content)) return fail(undone, `${reason}: rejected (undoes what the user asked to keep)`);
  const outcome = await ctx.host.proposeWrite(path, content, { isNew, reason });
  if (!outcome.applied) {
    const said = outcome.note ? ` They said: ${outcome.note}` : "";
    return fail(`The user rejected this change to ${path}.${said} Do what they asked, or try a different approach.`, `${reason}: rejected by user`);
  }
  ctx.edits.recordSuccess(path);
  if (outcome.note) {
    return ok(`${isNew ? "Created" : "Edited"} ${path}, but ${outcome.note}, so the file differs from your proposal. Re-read it before editing again.`, `${reason}: partly applied (${outcome.note})`, [path]);
  }
  note += unusedImportNote(path, before, content);
  return ok(`${isNew ? "Created" : "Edited"} ${path}.${note}`, `${reason}: applied`, [path]);
}

export const editFile: ToolDef<{ path: string; search: string; replace: string; all?: boolean }> = {
  name: "edit",
  kind: "write",
  description:
    "Replace one block of a file. `search` must be copied exactly from the file (a few whole lines, unique); `replace` is the new text for those lines. " +
    "all=true replaces every exact occurrence (e.g. renaming an identifier).",
  params: {
    type: "object",
    properties: { path: { type: "string" }, search: { type: "string", minLength: 1 }, replace: { type: "string" }, all: { type: "boolean" } },
    required: ["path", "search", "replace"],
  },
  async check(a, ctx) {
    const missing = await mustBeFile(a.path, ctx);
    if (missing) return missing;
    const before = await ctx.host.readFile(a.path);
    return placeholderIn(a.replace, before, a.path, ctx.todo) ?? moduleSystemProblem(a.path, a.replace, before, ctx);
  },
  async run(a, ctx) {
    const original = await ctx.host.readFile(a.path);
    a.search = restoreCopiedEscapes(a.search, toLf(original).split("\n")).text;
    let where = "";
    // A one-line `search` with a `replace` whose line breaks were escaped twice: `replace` alone decides.
    if (!a.search.includes("\n") && !a.search.includes("\\n") && doubleEscaped(a.replace)) {
      a.replace = unescapeBreaks(a.replace);
      where = ESCAPE_NOTE;
    }
    let r = fuzzyApply(original, a.search, a.replace, { all: a.all });
    // `search` with `\n` typed as text: when its unescaped form is in the file, the model escaped twice.
    if (!r.ok && !r.matches && !a.search.includes("\n") && a.search.includes("\\n")) {
      const search = unescapeBreaks(a.search);
      const replace = a.replace.includes("\n") ? a.replace : unescapeBreaks(a.replace);
      const retry = fuzzyApply(original, search, replace, { all: a.all });
      if (retry.ok || retry.matches) {
        Object.assign(a, { search, replace });
        r = retry;
        where = ESCAPE_NOTE;
      }
    }
    // Several matches: the ones inside the function the todo (or the model's thought) names are meant.
    const context = `${ctx.todo ?? ""}\n${ctx.thought ?? ""}`;
    const named = (d: Def | undefined) => !!d && new RegExp(`(?<![\\w$])${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(context);
    if (!r.ok && r.matches) {
      const matches = r.matches;
      const owners = await enclosingDefs(a.path, original, matches);
      const inNamed = matches.filter((_, i) => named(owners[i]));
      const picked = inNamed.length === 1 ? fuzzyApply(original, a.search, a.replace, { at: inNamed[0] }) : undefined;
      if (picked?.ok) {
        where = ` (\`search\` matched ${matches.length} places; changed the one in ${owners[matches.indexOf(inNamed[0])]!.name} at line ${inNamed[0]})`;
        r = picked;
      } else {
        const places = matches.map((l, i) => `line ${l}${owners[i] ? ` (in ${owners[i]!.name})` : ""}`).join(", ");
        r = { ...r, reason: `\`search\` matches ${matches.length} places: ${places}. Include the line above or below it (e.g. the function's first line) so it matches only one.` };
      }
    } else if (r.ok && a.all && (r.replaced?.length ?? 0) > 1) {
      // all=true across functions while the todo is about one of them: only that one (the others were collateral).
      const owners = await enclosingDefs(a.path, original, r.replaced!);
      const targets = [...new Set(owners.filter(named))];
      if (targets.length === 1 && owners.some((o) => o !== targets[0])) {
        const limited = fuzzyApply(original, a.search, a.replace, { all: true, within: [targets[0]!.line, targets[0]!.endLine] });
        if (limited.ok && limited.replaced?.length) {
          where = ` (only in ${targets[0]!.name}, which the task is about: ${limited.replaced.length} of ${r.replaced!.length} occurrences)`;
          r = limited;
        }
      }
    }
    if (r.ok) {
      let note = where || (r.strategy === "exact" ? "" : ` (matched ${r.strategy} at line ${r.startLine}, score ${r.score})`);
      let content = r.content;
      const whole = a.all ? undefined : await redefinition(a.path, original, a.search, a.replace, r.startLine);
      if (whole) {
        content = whole.content;
        note += ` (\`replace\` is a complete new ${whole.name}, so it replaced the whole old one, lines ${whole.from}-${whole.to})`;
      }
      const searchLines = toLf(a.search).replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "").split("\n").length;
      // `replace` re-typing the lines after `search` with some changed: the old ones would stay below (and override in Python).
      const retyped = !whole && !a.all ? retypedTail(original, content, r.startLine, searchLines) : undefined;
      if (retyped && !(await checkEditSyntax(a.path, original, retyped))) {
        content = retyped;
        note += RETYPED_NOTE;
      }
      // `replace` repeating the lines around `search` (a second closing brace): replace them instead, if that parses.
      if (!whole && !retyped && !a.all && (await checkEditSyntax(a.path, original, content, a.replace))) {
        let repaired = false;
        for (const c of overlapCandidates(original, content, r.startLine, searchLines)) {
          if (await checkEditSyntax(a.path, original, c)) continue;
          content = c;
          note += OVERLAP_NOTE;
          repaired = true;
          break;
        }
        // `search` was a block's first line and `replace` a complete block: it replaces the whole old block.
        for (const c of repaired ? [] : blockCandidates(original, r.startLine, a.search, a.replace, findImbalance)) {
          if (await checkEditSyntax(a.path, original, c)) continue;
          content = c;
          note += BLOCK_NOTE;
          break;
        }
      }
      return write(ctx, a.path, content, false, `edit ${a.path}`, note, a.replace);
    }
    // Redoing a change an earlier step (or todo) made: nothing to apply, and no reason to switch to line mode.
    if (r.alreadyApplied) {
      return {
        ...fail(`Already done: ${a.path} already contains this change. If the current todo is complete, call done now; otherwise do the next step.`, `edit ${a.path}: already applied`),
        noop: true,
      };
    }
    const switched = ctx.edits.recordFailure(a.path);
    let out = `Edit failed: ${r.reason}`;
    if (r.closest) out += `\nClosest match (similarity ${r.closest.score}):\n${r.closest.text}`;
    if (switched || ctx.edits.isLineRange(a.path)) {
      const lines = toLf(original).split("\n");
      out +=
        `\n\nSwitching ${a.path} to line-based editing. Use edit_lines with start_line/end_line from these numbered lines:\n` +
        numberLines(lines.slice(0, MAX_READ_LINES)) +
        (lines.length > MAX_READ_LINES ? `\n[${lines.length - MAX_READ_LINES} more lines; use read_file with start_line]` : "");
    }
    return fail(out, `edit ${a.path}: failed (${r.reason.split(".")[0]})`);
  },
};

export const rewriteFile: ToolDef<{ path: string; content: string }> = {
  name: "rewrite_file",
  kind: "write",
  description: "Replace the entire content of an existing small file. Write the complete file: never use placeholders like `// ... existing code ...`.",
  params: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async check(a, ctx) {
    fixEscapes(a);
    // Models "rewrite" the new file of a move or split: the complete content of a missing file creates it.
    if (await createsFile(a.path, ctx)) return createFile.check!(a, ctx);
    const refused = (await mustBeFile(a.path, ctx)) ?? (await mustUse("rewrite_file", a.path, ctx));
    if (refused) return refused;
    const before = await ctx.host.readFile(a.path);
    return stubIn(a.content, before, a.path, ctx.todo) ?? wholeFileModules(a, before, ctx);
  },
  async run(a, ctx) {
    if ((await ctx.host.stat(a.path)) === null) return createFile.run(a, ctx);
    const original = await ctx.host.readFile(a.path);
    const merged = mergeLazyRewrite(original, a.content);
    if (!merged.ok) return fail(merged.reason, `rewrite_file ${a.path}: placeholders could not be merged`);
    const note = merged.filled ? ` (${merged.filled} "existing code" placeholder(s) were filled from the original)` : "";
    return write(ctx, a.path, merged.content, false, `rewrite_file ${a.path}`, note + escapeNote(a));
  },
};

export const editLines: ToolDef<{ path: string; start_line: number; end_line: number; content: string }> = {
  name: "edit_lines",
  kind: "write",
  description: "Replace lines start_line..end_line (inclusive, 1-based) with `content`. Use end_line = start_line - 1 to insert. Only for files shown with line numbers.",
  params: {
    type: "object",
    properties: {
      path: { type: "string" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 0 },
      content: { type: "string" },
    },
    required: ["path", "start_line", "end_line", "content"],
  },
  async check(a, ctx) {
    fixEscapes(a);
    if (a.start_line === 1 && a.end_line === 0 && (await createsFile(a.path, ctx))) return createFile.check!(a, ctx);
    const refused = (await mustBeFile(a.path, ctx)) ?? (await mustUse("edit_lines", a.path, ctx));
    return refused ?? moduleSystemProblem(a.path, a.content, await ctx.host.readFile(a.path), ctx);
  },
  async run(a, ctx) {
    if ((await ctx.host.stat(a.path)) === null) return createFile.run(a, ctx);
    const original = await ctx.host.readFile(a.path);
    const range = widenForReassignment(original, a.start_line, a.end_line, a.content);
    const r = applyLineRange(original, range.start, range.end, a.content);
    if (!r.ok) return fail(`edit_lines failed: ${r.reason}`);
    let note =
      range.start !== a.start_line || range.end !== a.end_line
        ? ` (the old assignment next to your range would have overridden your new one, so lines ${range.start}-${range.end} were replaced)`
        : "";
    // The same slips as with `edit`: a range that is only a block's first line, new text re-typing the lines after it.
    let content = r.content;
    const count = range.end - range.start + 1;
    if (count > 0) {
      const retyped = retypedTail(original, content, range.start, count);
      if (retyped && !(await checkEditSyntax(a.path, original, retyped))) {
        content = retyped;
        note += RETYPED_NOTE;
      } else if (await checkEditSyntax(a.path, original, content, a.content)) {
        const rangeText = toLf(original).split("\n").slice(range.start - 1, range.end).join("\n");
        const overlap = overlapCandidates(original, content, range.start, count).map((c) => ({ c, why: OVERLAP_NOTE }));
        const block = blockCandidates(original, range.start, rangeText, a.content, findImbalance).map((c) => ({ c, why: BLOCK_NOTE }));
        for (const { c, why } of [...overlap, ...block]) {
          if (await checkEditSyntax(a.path, original, c)) continue;
          content = c;
          note += why;
          break;
        }
      }
    }
    return write(ctx, a.path, content, false, `edit_lines ${a.path}:${range.start}-${range.end}`, escapeNote(a) + note, a.content);
  },
};

export const createFile: ToolDef<{ path: string; content: string }> = {
  name: "create_file",
  kind: "write",
  description: "Create a new file (parent folders are created). Fails if the file exists.",
  params: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async check(a, ctx) {
    fixEscapes(a);
    if (await ctx.host.stat(a.path)) {
      // A file a generator made in this run (vite's App.vue): the model writes the real one over it.
      if (ctx.generated?.has(a.path)) {
        const before = await ctx.host.readFile(a.path);
        return stubIn(a.content, before, a.path, ctx.todo) ?? wholeFileModules(a, before, ctx);
      }
      return `"${a.path}" already exists. Use edit to change it.`;
    }
    const base = a.path.split("/").pop()!;
    if (/^\.(slnx?|csproj|fsproj|cs|py|js|ts|tsx|json|go|rs|java)$/.test(base)) {
      return `"${base}" has no file name, only an extension. Name it (e.g. TodoApi${base})${/sln/.test(base) ? ", or better run `dotnet new sln -n <Name>` and `dotnet sln add <project>`" : ""}.`;
    }
    const twin = await projectTwin(a.path, ctx);
    if (twin) return `${twin} already exists in this project, and a second ${a.path.split("/").pop()} would break it. Edit ${twin} instead.`;
    // An empty file is a wasted step (and then an edit on nothing); only markers may be empty.
    if (!a.content.trim() && !/(^|\/)(__init__\.py|\.gitkeep|\.keep|py\.typed)$/.test(a.path)) {
      return `content is empty. Create ${a.path} with its complete content in this call.`;
    }
    return placeholderIn(a.content, "", a.path, ctx.todo) ?? wholeFileModules(a, "", ctx);
  },
  run: async (a, ctx) => {
    const replaces = (await ctx.host.stat(a.path)) === "file";
    return write(ctx, a.path, collapseBlankRuns(toLf(a.content), 2), !replaces, `create_file ${a.path}${replaces ? " (replaced the generated file)" : ""}`, escapeNote(a));
  },
};
