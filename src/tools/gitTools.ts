import { spawn } from "node:child_process";
import { truncateOutput } from "./output";
import { fail, ok, ToolContext, ToolDef } from "./types";

/** Runs git without a shell, so arguments can't be interpreted as commands. */
function git(args: string[], ctx: ToolContext): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", ["--no-pager", "-c", "core.quotepath=off", ...args], { cwd: ctx.host.root, signal: ctx.signal });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/** The file as last committed in the user's repository; undefined outside git or for a new file. */
export async function committedVersion(path: string, ctx: ToolContext): Promise<string | undefined> {
  const r = await git(["show", `HEAD:${path}`], ctx);
  return r.code === 0 ? r.out : undefined;
}

async function mustExist(path: string | undefined, ctx: ToolContext): Promise<string | undefined> {
  return path && !(await ctx.host.stat(path)) ? `"${path}" does not exist.` : undefined;
}

export const gitDiff: ToolDef<{ path?: string; staged?: boolean }> = {
  name: "git_diff",
  kind: "read",
  group: "git",
  description: "Show uncommitted changes (unified diff). Optional path limits it to a file or folder; staged=true shows staged changes instead.",
  params: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" } } },
  check: (a, ctx) => mustExist(a.path, ctx),
  async run(a, ctx) {
    const r = await git(["diff", ...(a.staged ? ["--staged"] : []), "--", ...(a.path ? [a.path] : [])], ctx);
    if (r.code !== 0) return fail(`git diff failed: ${r.out.trim()}`);
    const where = a.path ?? "workspace";
    if (!r.out.trim()) return ok(`No ${a.staged ? "staged " : ""}changes in ${where}.`, `git_diff ${where}: no changes`);
    const files = (r.out.match(/^diff --git /gm) ?? []).length;
    return ok(truncateOutput(r.out, 200), `git_diff ${where}: ${files} file(s) changed`);
  },
};

export const gitLog: ToolDef<{ path?: string; count?: number }> = {
  name: "git_log",
  kind: "read",
  group: "git",
  description: "Recent commits (hash, date, author, subject), newest first. Optional path limits it to a file or folder; count defaults to 10.",
  params: { type: "object", properties: { path: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 50 } } },
  check: (a, ctx) => mustExist(a.path, ctx),
  async run(a, ctx) {
    const r = await git(["log", "--date=short", "--pretty=format:%h %ad %an  %s", "-n", String(a.count ?? 10), "--", ...(a.path ? [a.path] : [])], ctx);
    if (r.code !== 0) return fail(`git log failed: ${r.out.trim()}`);
    if (!r.out.trim()) return ok("No commits.", "git_log: no commits");
    return ok(r.out.trim(), `git_log ${a.path ?? ""}: ${r.out.trim().split("\n").length} commits`);
  },
};

const BLAME_LINES = 80;

export const gitBlame: ToolDef<{ path: string; start_line?: number; end_line?: number }> = {
  name: "git_blame",
  kind: "read",
  group: "git",
  description: `Who last changed each line of a file (commit, author, date). Optional start_line/end_line (1-based); at most ${BLAME_LINES} lines.`,
  params: {
    type: "object",
    properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
    required: ["path"],
  },
  async check(a, ctx) {
    const kind = await ctx.host.stat(a.path);
    return kind === "file" ? undefined : `"${a.path}" is not a file in the workspace.`;
  },
  async run(a, ctx) {
    const start = a.start_line ?? 1;
    const end = Math.min(a.end_line ?? start + BLAME_LINES - 1, start + BLAME_LINES - 1);
    if (end < start) return fail("end_line must be ≥ start_line.");
    const r = await git(["blame", "--date=short", "-L", `${start},${end}`, "--", a.path], ctx);
    if (r.code !== 0) return fail(`git blame failed: ${r.out.trim()}`);
    return ok(r.out.trimEnd(), `git_blame ${a.path}:${start}-${end}`);
  },
};
