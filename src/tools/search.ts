import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { IGNORED_DIRS } from "./paths";
import { fail, ok, ToolContext, ToolDef, ToolResult } from "./types";

const MAX_MATCHES = 60;

/** Host-provided rg (VS Code ships one) → @vscode/ripgrep platform package → rg on PATH. */
export function findRg(hostPath?: string): string {
  if (hostPath && existsSync(hostPath)) return hostPath;
  try {
    const req = createRequire(__filename);
    const bin = process.platform === "win32" ? "rg.exe" : "rg";
    return req.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${bin}`);
  } catch {
    return "rg";
  }
}

export const search: ToolDef<{ query: string; path?: string; regex?: boolean; semantic?: boolean }> = {
  name: "search",
  kind: "read",
  description:
    "Search file contents (ripgrep). Literal text by default; set regex=true for a regular expression. Optional path limits the folder or file. " +
    "semantic=true finds code by meaning when you don't know the names (\"where are passwords hashed\"), if an embedding model is set up.",
  params: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 }, path: { type: "string" }, regex: { type: "boolean" }, semantic: { type: "boolean" } },
    required: ["query"],
  },
  async check(a, ctx) {
    return a.path && !(await ctx.host.stat(a.path)) ? `"${a.path}" does not exist.` : undefined;
  },
  async run(a, ctx) {
    if (a.semantic && ctx.semantic) return semanticSearch(a.query, ctx);
    const off = a.semantic ? "[Semantic search is off (no embedding model is set up); these are text matches.]\n" : "";
    const r = await textSearch(a, ctx);
    return off ? { ...r, output: off + r.output } : r;
  },
};

async function textSearch(a: { query: string; path?: string; regex?: boolean }, ctx: ToolContext): Promise<ToolResult> {
  const args = ["--line-number", "--no-heading", "--color=never", "--path-separator=/", "--max-columns=200", "--max-columns-preview", "--smart-case"];
  if (!a.regex) args.push("--fixed-strings");
  for (const d of IGNORED_DIRS) args.push("--glob", `!${d}/`);
  args.push("--", a.query, a.path ?? ".");
  const { code, stdout, stderr } = await exec(findRg(ctx.host.rgPath?.()), args, ctx.host.root, ctx.signal);
  if (code === 2 && !stdout) return fail(`search error: ${stderr.trim()}`);
  const lines = stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""));
  if (!lines.length) return ok(`No matches for "${a.query}".`, `search "${a.query}": no matches`);
  const files = new Set(lines.map((l) => l.slice(0, l.indexOf(":"))));
  const more = lines.length > MAX_MATCHES ? `\n[${lines.length - MAX_MATCHES} more matches; narrow the query or path]` : "";
  return ok(lines.slice(0, MAX_MATCHES).join("\n") + more, `search "${a.query}": ${lines.length} matches in ${files.size} files (${[...files].slice(0, 3).join(", ")})`);
}

function exec(cmd: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, signal });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 2, stdout, stderr }));
  });
}

/** Code found by meaning, from the embedding index (`search` with semantic=true). */
async function semanticSearch(query: string, ctx: ToolContext): Promise<ToolResult> {
  const hits = await ctx.semantic!.search(query, 8, ctx.signal);
  if (!hits.length) return ok("The index is empty.", `search (semantic) "${query}": no results`);
  const out: string[] = [];
  for (const h of hits) {
    const lines = (await ctx.host.readFile(h.path).catch(() => "")).replace(/\r\n/g, "\n").split("\n");
    const preview = lines.slice(h.line - 1, Math.min(h.endLine, h.line + 5)).join("\n");
    out.push(`${h.path}:${h.line}-${h.endLine} (score ${h.score.toFixed(2)})\n${preview}`);
  }
  return ok(out.join("\n\n"), `search (semantic) "${query}": ${hits.slice(0, 3).map((h) => `${h.path}:${h.line}`).join(", ")}`);
}
