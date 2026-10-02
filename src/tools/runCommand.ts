import { nestedProjectProblem } from "../context/projectChecks";
import { listFiles } from "../context/repoMap";
import { decideCommand } from "./commandPolicy";
import { missingUsings, projectTypes } from "./missingImports";
import { relativizePaths, truncateOutput } from "./output";
import { resolveWorkspacePath } from "./paths";
import { startProcess } from "./processes";
import { errorContext, failureReport, lintHints, parseTestFailures } from "./testReport";
import { fail, ok, ToolContext, ToolDef, ToolResult } from "./types";

export const runCommand: ToolDef<{ command: string; cwd?: string }> = {
  name: "run_command",
  kind: "exec",
  description:
    "Run a shell command (build, test, lint, project generators) and get its exit code and output. `cwd`: folder relative to the workspace root (default: root). " +
    "Commands are stopped after 2 minutes; servers and watchers (dotnet run, npm start, npm run dev) are started in the background instead.",
  params: { type: "object", properties: { command: { type: "string", minLength: 1 }, cwd: { type: "string" } }, required: ["command"] },
  async check(a, ctx) {
    if (a.cwd === undefined) return undefined;
    const r = resolveWorkspacePath(ctx.host.root, a.cwd);
    if ("error" in r) return r.error;
    if ((await ctx.host.stat(r.path)) !== "dir") return `cwd "${a.cwd}" is not a folder in the workspace.`;
    a.cwd = r.path;
    return undefined;
  },
  async run(a, ctx) {
    const literal = unexpandedVariables(a.command);
    if (literal.length) {
      return fail(
        `Not run: ${literal.join(", ")} ${literal.length > 1 ? "are" : "is"} inside single quotes, so the shell would send ${literal.length > 1 ? "them" : "it"} literally ` +
          `(e.g. a JSON body with "$PROJECT_KEY" instead of its value). Put the value outside the single quotes, or better, write the request as a Python script: ` +
          `python3 - <<'EOF' ... EOF, reading the .env file in the script and building the body with json.dumps.`,
        `run_command: refused (variables inside single quotes)`,
      );
    }
    const moved = await rootRelativePaths(a.command, a.cwd, ctx);
    if (moved) a.cwd = undefined;
    const note = moved ? `(Ran from the workspace root: ${moved} is relative to the root, not to cwd.)\n` : "";
    const res = await runIn(a, ctx);
    return note ? { ...res, output: note + res.output } : res;
  },
};

/**
 * `$ENV_VAR` / `${ENV_VAR}` / `$(cmd)` inside single quotes of the command line: the shell passes
 * them on literally. Small models write curl JSON bodies that way and the API gets
 * `{"key": "$JIRA_PROJECT_KEY"}`. Only upper-case names of 3+ characters count (awk's `$1`/`$NF`,
 * jq's `$name` are meant literally), heredoc bodies are skipped, and so are commands that hand
 * the string to another shell (`bash -c '...$(date)'`).
 */
export function unexpandedVariables(command: string): string[] {
  const line = command.includes("<<") ? command.split("\n")[0] : command;
  if (/\b(ba|z)?sh\s+-c\b|\bssh\b|\bdocker\b|\bkubectl\b|\bxargs\b|-exec\b|\bwatch\b|\benvsubst\b/.test(line)) return [];
  const found: string[] = [];
  let quote: string | null = null;
  let seg = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") {
        found.push(...[...seg.matchAll(/\$(\{[A-Z][A-Z0-9_]{2,}\}|[A-Z][A-Z0-9_]{2,}|\([^)]*\))/g)].map((m) => m[0]));
        quote = null;
      } else seg += c;
    } else if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') {
      quote = c;
      seg = "";
    }
  }
  return [...new Set(found)];
}

/**
 * Models set `cwd` and then write paths from the workspace root ("cwd: TodoApi" +
 * "dotnet build TodoApi/TodoApi.csproj"); the command fails with "file not found" and
 * the model concludes its fix didn't work. When every path in the command exists from
 * the root but not from cwd, the command runs from the root. Returns the path, if so.
 */
async function rootRelativePaths(command: string, cwd: string | undefined, ctx: ToolContext): Promise<string | undefined> {
  if (!cwd || cwd === ".") return undefined;
  // "cwd: frontend-v2" + "cd frontend-v2 && npm install": the cd is written from the root.
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)/.exec(command)?.[1]?.replace(/^["']|["']$/g, "");
  if (cd && !cd.startsWith("/") && !(await ctx.host.stat(`${cwd}/${cd}`)) && (await ctx.host.stat(cd.replace(/^\.\//, ""))) === "dir") return cd;
  const tokens = command.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => /[\\/]/.test(t) && !/^(-|https?:|\/)/.test(t) && !t.includes(".."));
  if (!tokens.length) return undefined;
  let found: string | undefined;
  for (const t of tokens) {
    const fromCwd = await ctx.host.stat(`${cwd}/${t}`.replace(/\/\.\//g, "/"));
    if (fromCwd) return undefined; // at least one path is meant from cwd
    if (await ctx.host.stat(t.replace(/^\.\//, ""))) found ??= t;
  }
  return found;
}

async function runIn(a: { command: string; cwd?: string }, ctx: ToolContext): Promise<ToolResult> {
  const server = await serverReason(a.command, a.cwd ?? ".", ctx);
  if (server) {
    // A server never exits: run it in the background (like start_process) instead of waiting for the timeout.
    if (ctx.processes) {
      (ctx.needs ??= new Set()).add("process");
      const r = await startProcess.run({ command: a.command, cwd: a.cwd }, ctx);
      return { ...r, output: `This starts a server, so it runs in the background (read its output with process_logs).\n${r.output}` };
    }
    return fail(`Not run: ${server}`, `run_command "${a.command}": refused (server)`);
  }
  const decision = decideCommand(a.command, ctx.commandAllowlist, ctx.commandDeny);
  if (decision.kind === "block") return fail(`Command blocked (${decision.reason}). Do not retry it.`, `run_command "${a.command}": blocked`);
  if (decision.kind === "confirm" && !ctx.preApproved) {
    const approval = ctx.host.approveCommand
      ? await ctx.host.approveCommand(a.command, decision.reason)
      : { ok: await ctx.host.confirm(`Run \`${a.command}\`? (${decision.reason})`) };
    if (!approval.ok) {
      const why = approval.feedback ? ` They said: ${approval.feedback}` : "";
      return fail(`The user declined to run this command.${why}`, `run_command "${a.command}": declined`);
    }
  }
  const before = new Set(await listFiles(ctx.host));
  let r = await ctx.host.runCommand(a.command, ctx.signal, { cwd: a.cwd });
  // A C# build that only lacks well-known using directives: add them by code and run again.
  let fixed = "";
  const changed: string[] = [];
  if (r.exitCode !== 0) {
    const read = (p: string) => ctx.host.readFile(p);
    const fix = await missingUsings(r.output, ctx.host.root, read, async () => projectTypes(await listFiles(ctx.host), read));
    if (fix.changes.length && (await ctx.host.proposeWrites(fix.changes, "add missing using directives")).applied) {
      fixed = `${fix.note} Output after that fix:\n`;
      changed.push(...fix.changes.map((c) => c.path));
      r = await ctx.host.runCommand(a.command, ctx.signal, { cwd: a.cwd });
    }
  }
  // Generators (dotnet new, npm create) decide the layout; show it so later steps use real paths.
  const created = (await listFiles(ctx.host)).filter((f) => !before.has(f)).sort();
  if (created.length) created.forEach((f) => (ctx.generated ??= new Set()).add(f));
  const newFiles = created.length ? `\nNew files (${created.length}): ${created.slice(0, 20).join(", ")}${created.length > 20 ? ", ..." : ""}` : "";
  const failedTests = r.exitCode !== 0 && parseTestFailures(r.output, ctx.host.root).length > 0;
  const out =
    fixed +
    relativizePaths(r.exitCode === 0 ? truncateOutput(r.output) : failureReport(r.output, ctx.host.root), ctx.host.root) +
    (r.exitCode === 0 ? "" : await errorContext(r.output, ctx.host.root, (p) => ctx.host.readFile(p))) +
    (failedTests ? await lintHints(ctx.seen ?? [], (p) => ctx.host.readFile(p)) : "");
  const where = a.cwd && a.cwd !== "." ? ` (in ${a.cwd})` : "";
  const timeout = r.timedOut
    ? "\n[Timed out after 2 minutes and was stopped. Servers and watchers never finish; check your work with a build or tests instead.]"
    : "";
  // A project generated inside another project's folder breaks the outer build: say so now, and on every failing dotnet command.
  const layout =
    (created.some((f) => /\.(cs|fs|vb)proj$/.test(f)) || (r.exitCode !== 0 && /\bdotnet\b/.test(a.command))) && nestedProjectProblem([...before, ...created]);
  // A passing build with compiler warnings (CS8765 ...): small models set out to fix them and break the build.
  const warnings = r.exitCode === 0 && /\bwarning\s+[A-Z]{2,}\d{3,}\b/.test(r.output) ? "\n[It succeeded. The warnings don't block anything: leave them unless the task is about them.]" : "";
  const text = `$ ${a.command}${where}\nexit code ${r.exitCode}\n${out}${warnings}${timeout}${newFiles}${layout ? `\n\nWarning: ${layout}` : ""}`;
  const summary = `run_command "${a.command}"${where}: ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}${fixed ? " (after adding using directives)" : ""}`;
  return r.exitCode === 0 ? ok(text, summary, changed.length ? changed : undefined) : { ok: false, output: text, summary, changed: changed.length ? changed : undefined };
}

const SERVER_COMMANDS: [RegExp, string][] = [
  [/\bdotnet\s+watch\b/, "dotnet build"],
  [/\bnpm\s+(start|run\s+(dev|serve|start|watch))\b|\b(yarn|pnpm)\s+(dev|start|serve)\b|(?:^|[;&|(]\s*|\bnpx\s+)(?:vite(?!\s+build)|nodemon|next\s+dev)(?=\s|$)/, "npm run build (or npm test)"],
  [/\b(uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|rails\s+s(erver)?)\b|\bpython3?\s+-m\s+http\.server\b/, "the tests or a syntax/import check"],
];

/** A script run directly (`node server.js`, `python app.py`, `go run .`). */
const SCRIPT = /^\s*(?:node|python3?|py|go\s+run)\s+(?:-[\w-]+\s+)*("[^"]+"|[\w./\\-]+)/;
/** Code that listens for connections: running such a file starts a server. */
const SERVER_CODE = /\.listen\(|\bapp\.run\(|\buvicorn\.run\(|\bserve_forever\(|\brun_simple\(|\bweb\.run_app\(|\bListenAndServe(TLS)?\(/;

/**
 * Commands that start a server or watcher never exit, so they only burn the
 * timeout. `dotnet run` is refused only for web projects (console apps are fine);
 * a script counts when its file contains server code.
 */
async function serverReason(command: string, cwd: string, ctx: ToolContext): Promise<string | undefined> {
  for (const [re, instead] of SERVER_COMMANDS) {
    if (re.test(command)) return `\`${command}\` starts a server/watcher that never exits. Check your work with ${instead} instead.`;
  }
  const script = SCRIPT.exec(command)?.[1]?.replace(/"/g, "");
  if (script) {
    const rel = resolveWorkspacePath(ctx.host.root, `${cwd}/${script}`);
    const file = "error" in rel ? undefined : (await ctx.host.stat(rel.path)) === "dir" ? `${rel.path}/main.go` : rel.path;
    const code = file ? await ctx.host.readFile(file).catch(() => "") : "";
    if (SERVER_CODE.test(code)) return `\`${command}\` starts a server that never exits. Check your work with the tests instead.`;
  }
  if (!/\bdotnet\s+run\b/.test(command)) return undefined;
  const project = /--project\s+("[^"]+"|\S+)/.exec(command)?.[1]?.replace(/"/g, "");
  const candidates = project
    ? [project.endsWith("proj") ? project : `${project}`]
    : (await ctx.host.listDir(cwd).catch(() => [])).filter((e) => e.type === "file" && /\.csproj$/.test(e.name)).map((e) => `${cwd}/${e.name}`);
  for (const c of candidates) {
    const file = c.endsWith("proj") ? c : (await ctx.host.listDir(c).catch(() => [])).map((e) => `${c}/${e.name}`).find((n) => n.endsWith(".csproj"));
    if (!file) continue;
    const text = await ctx.host.readFile(file.replace(/^\.\//, "")).catch(() => "");
    if (/Microsoft\.NET\.Sdk\.Web/.test(text)) {
      return "this is an ASP.NET web project, so `dotnet run` starts a server that never exits. Check it with `dotnet build` instead.";
    }
  }
  return undefined;
}
