/**
 * Eval harness: `node dist/eval.js run [--filter x] [--model m] [--runs n]`,
 * `node dist/eval.js validate [--filter x]`, `node dist/eval.js fim [--model m] [--cpu]` (autocomplete
 * latency) and `node dist/eval.js export [--out file] <results dirs...>`.
 *
 * A task is a folder in eval/tasks/<id>/ with
 *   task.json  { "task": "...", "check": "<command>", "mode"?: "agent", ...TaskSpec }
 *   repo/      starting workspace (copied to a temp dir per run, then committed)
 *   setup/     optional: files copied over the workspace after that commit (uncommitted changes)
 *   check/     hidden files copied over the workspace AFTER the agent finishes
 *              (tests the agent must not see or edit); then `check` must exit 0.
 *   solution/  optional: a reference solution for `validate` (never shown to the agent);
 *              `solution/.remove` lists files the solution deletes.
 *   web.json   optional: recorded web answers (see `web`).
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { Agent, AgentDeps, RunResult, RunStats } from "../src/agent/loop";
import { buildFimPrompt, postprocessCompletion } from "../src/autocomplete/fim";
import { loadRules } from "../src/context/rules";
import { NodeHost } from "../src/host/nodeHost";
import { runCommandSync } from "../src/host/shell";
import { McpHub, McpServerConfig } from "../src/mcp/hub";
import { createProvider } from "../src/providers";
import type { ModelProfile } from "../src/providers/modelProfiles";
import type { AgentMode } from "../src/tools/registry";
import type { Turn } from "../src/ui/protocol";
import { applyEvent, conversationText, pendingPlanFor } from "../src/ui/transcript";
import type { WebRecording } from "../src/web/search";

interface TaskSpec {
  task: string;
  check: string;
  mode?: AgentMode;
  allow?: string[];
  /** Approve every command and MCP call the command policy doesn't block (the "Run everything" mode). */
  approve?: boolean;
  /** MCP servers for the run; `{task}` (the task folder) and `{workspace}` expand in command, args and env. */
  mcp?: Record<string, McpServerConfig>;
  /** Recorded web answers (a file in the task folder, see WebRecording): web tools on, no network. */
  web?: string;
  /** Earlier messages of the same conversation, run first (e.g. a plan, then "go"). */
  before?: { text: string; mode?: AgentMode }[];
}

interface TaskResult {
  id: string;
  run: number;
  pass: boolean;
  status: RunResult["status"];
  steps: number;
  modelCalls: number;
  invalidCalls: number;
  refusedCalls: number;
  editCalls: number;
  editsApplied: number;
  ms: number;
  checkOutput: string;
}

const ALLOW = ["node --test", "npm test", "dotnet build", "dotnet test", "dotnet run", "python3 -m unittest", "python -m unittest", "go test", "go build", "go vet", "ls", "cat", "git status", "git diff"];

async function run(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: "string", default: path.join(process.cwd(), "eval", "tasks") },
      out: { type: "string", default: path.join(process.cwd(), "eval", "results") },
      filter: { type: "string", default: "" },
      model: { type: "string", default: "qwen2.5-coder-32k:latest" },
      provider: { type: "string", default: "ollama" },
      endpoint: { type: "string", default: "http://localhost:11434" },
      "tool-mode": { type: "string" },
      runs: { type: "string", default: "1" },
      "max-steps": { type: "string", default: "15" },
      "embed-model": { type: "string" },
    },
  });
  const ids = readdirSync(values.tasks!)
    .filter((d) => existsSync(path.join(values.tasks!, d, "task.json")) && matchesFilter(d, values.filter!))
    .sort();
  if (!ids.length) throw new Error(`no tasks in ${values.tasks} matching "${values.filter}"`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(values.out!, stamp);
  mkdirSync(path.join(outDir, "trajectories"), { recursive: true });
  const toolMode = values["tool-mode"] as ModelProfile["toolMode"] | undefined;
  const provider = createProvider({
    provider: values.provider as "ollama" | "openai",
    endpoint: values.endpoint!,
    model: values.model!,
    profiles: toolMode ? [{ match: values.model!, toolMode }] : [],
  });
  const results: TaskResult[] = [];

  for (const id of ids) {
    for (let r = 0; r < Number(values.runs); r++) {
      const dir = path.join(values.tasks!, id);
      const spec = readSpec(dir);
      const ws = prepareWorkspace(dir, id);
      const mcp = mcpFor(spec, dir, ws);

      process.stderr.write(`▶ ${id}${Number(values.runs) > 1 ? ` #${r + 1}` : ""} … `);
      const { res, stats: s, logs } = await converse(spec, {
        host: new NodeHost(ws, { autoApprove: true, interactive: false, confirm: spec.approve ? async () => true : undefined }),
        provider,
        commandAllowlist: [...ALLOW, ...(spec.allow ?? [])],
        claudeHooks: false, // the machine's own ~/.claude hooks and skills would change the results
        userSkills: false,
        maxStepsPerTodo: Number(values["max-steps"]),
        embeddingModel: values["embed-model"],
        web: spec.web ? { provider: "duckduckgo", replay: JSON.parse(readFileSync(path.join(dir, spec.web), "utf8")) as WebRecording } : undefined,
        mcp,
      }).finally(() => mcp?.close());

      if (existsSync(path.join(dir, "check"))) cpSync(path.join(dir, "check"), ws, { recursive: true });
      // The agent's shell (Git Bash on Windows): checks are POSIX (`test -f`, `! grep -q`).
      const check = runCommandSync(spec.check, { cwd: ws, timeoutMs: 5 * 60_000 });
      const pass = check.status === 0;
      results.push({
        id, run: r, pass, status: res.status, steps: s.steps, modelCalls: s.modelCalls, invalidCalls: s.invalidCalls, refusedCalls: s.refusedCalls ?? 0,
        editCalls: s.editCalls, editsApplied: s.editsApplied, ms: s.ms, checkOutput: check.output.slice(-2000),
      });
      const log = path.join(outDir, "trajectories", `${id}-${r}${pass ? "-pass" : "-fail"}.jsonl`);
      writeFileSync(log, logs.map((f) => readFileSync(f, "utf8")).join(""));
      process.stderr.write(`${pass ? "PASS" : "FAIL"} (${res.status}, ${s.steps} steps, ${(s.ms / 1000).toFixed(0)}s)\n`);
    }
  }

  const summary = aggregate(results);
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ model: values.model, toolMode: provider.profile.toolMode, summary, results }, null, 2));
  const previous = previousSummary(values.out!, stamp);
  console.log(`\n${table(summary, previous)}\n\nresults: ${outDir}`);
}

/** `--filter a,b`: task ids containing any of the comma-separated parts (all tasks when empty). */
function matchesFilter(id: string, filter: string): boolean {
  const parts = filter.split(",").map((f) => f.trim()).filter(Boolean);
  return !parts.length || parts.some((f) => id.includes(f));
}

function readSpec(dir: string): TaskSpec {
  return JSON.parse(readFileSync(path.join(dir, "task.json"), "utf8")) as TaskSpec;
}

/** The task's repo in a temp dir, committed (so git tools and checkpoints have a base), then `setup/` on top. */
function prepareWorkspace(dir: string, id: string): string {
  const ws = mkdtempSync(path.join(tmpdir(), `eval-${id}-`));
  cpSync(path.join(dir, "repo"), ws, { recursive: true });
  execSync("git init -q && git -c core.autocrlf=false add -A && git -c user.name=eval -c user.email=eval@localhost -c commit.gpgsign=false commit -qm start", { cwd: ws, stdio: "ignore" });
  if (existsSync(path.join(dir, "setup"))) cpSync(path.join(dir, "setup"), ws, { recursive: true });
  return ws;
}

function mcpFor(spec: TaskSpec, dir: string, ws: string): McpHub | undefined {
  if (!spec.mcp) return undefined;
  const x = (v: string) => v.replace(/\{task\}/g, path.resolve(dir)).replace(/\{workspace\}/g, ws);
  const configs = Object.fromEntries(
    Object.entries(spec.mcp).map(([name, c]) => [
      name,
      { ...c, command: c.command && x(c.command), args: c.args?.map(x), env: c.env && Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, x(v)])) },
    ]),
  );
  return new McpHub(configs, ws);
}

/** Runs `before` messages and then the task as one conversation, like the chat does. */
async function converse(spec: TaskSpec, deps: AgentDeps): Promise<{ res: RunResult; stats: RunStats; logs: string[] }> {
  const turns: Turn[] = [];
  const logs: string[] = [];
  let res: RunResult | undefined;
  let stats: RunStats | undefined;
  for (const msg of [...(spec.before ?? []), { text: spec.task, mode: spec.mode }]) {
    let mode: AgentMode = msg.mode ?? "agent";
    const plan = mode !== "ask" ? pendingPlanFor(turns, msg.text) : undefined;
    if (plan) mode = "agent";
    const turn: Turn = { id: String(Date.now()), items: [{ kind: "user", text: msg.text, mode }], running: true };
    res = await new Agent({ ...deps, onEvent: (e) => applyEvent(turn, e) }).run(msg.text, mode, undefined, { conversation: conversationText(turns), plan });
    turn.running = false;
    turns.push(turn);
    if (res.logFile) logs.push(res.logFile);
    stats = stats ? addStats(stats, res.stats) : res.stats;
  }
  return { res: res!, stats: stats!, logs };
}

function addStats(a: RunStats, b: RunStats): RunStats {
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof RunStats] + b[k as keyof RunStats]])) as unknown as RunStats;
}

/**
 * `fim`: autocomplete latency, the plan's "p50 < 500ms on a GPU, ~1s on a CPU with a 1.5B
 * model". Cursor positions are taken from the eval repos' source files (at the start of a
 * line inside a body, with its indentation typed, and in the middle of a line), prompted
 * and post-processed exactly like the editor's FimProvider.
 */
async function fimBench(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: "string", default: path.join(process.cwd(), "eval", "tasks") },
      model: { type: "string", default: "qwen2.5-coder:1.5b" },
      endpoint: { type: "string", default: "http://localhost:11434" },
      n: { type: "string", default: "40" },
      cpu: { type: "boolean", default: false },
    },
  });
  const provider = createProvider({
    provider: "ollama",
    endpoint: values.endpoint!,
    model: values.model!,
    profiles: values.cpu ? [{ match: values.model!, ollamaOptions: { num_gpu: 0 } }] : [],
  });
  const fim = provider.profile.fim;
  if (!fim) throw new Error(`${values.model} has no FIM tokens in its profile`);
  const samples = fimSamples(values.tasks!, Number(values.n));
  const run = async (s: FimSample) => {
    const t0 = Date.now();
    const raw = await provider.complete({
      prompt: buildFimPrompt(fim, { path: s.path, prefix: s.prefix, suffix: s.suffix }),
      maxTokens: 128,
      temperature: 0.1,
      stop: fim.stop,
    });
    return { ms: Date.now() - t0, text: postprocessCompletion(raw, s.prefix, s.suffix) };
  };
  for (const s of samples.slice(0, 2)) await run(s); // load the model
  const times: number[] = [];
  let empty = 0;
  let asWritten = 0;
  const norm = (l: string) => l.replace(/\s+/g, " ").trim();
  for (const s of samples) {
    const r = await run(s);
    times.push(r.ms);
    if (!r.text.trim()) empty++;
    if (norm(r.text.split("\n")[0]) === norm(s.expected)) asWritten++;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  console.log(`${values.model}${values.cpu ? " (CPU only)" : ""}: ${samples.length} completions`);
  console.log(`p50 ${pct(50)}ms · p90 ${pct(90)}ms · max ${sorted[sorted.length - 1]}ms · ${empty} empty · first line as the file has it: ${asWritten}/${samples.length}`);
}

interface FimSample {
  path: string;
  prefix: string;
  suffix: string;
  /** The rest of the line as the file has it; removed from the suffix, as if not typed yet. */
  expected: string;
}

/**
 * Deterministic cursor positions in the eval repos' code files: at the indentation of a body
 * line, and in its middle. The rest of that line is removed, as if it weren't typed yet.
 */
function fimSamples(tasksDir: string, n: number): FimSample[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ts|py|cs|go)$/.test(e.name) && !/test/i.test(e.name)) files.push(p);
    }
  };
  for (const id of readdirSync(tasksDir).sort()) if (existsSync(path.join(tasksDir, id, "repo"))) walk(path.join(tasksDir, id, "repo"));
  const out: FimSample[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    // Lines inside a body (indented, not a closing brace): complete them from their indentation, or from their middle.
    const body = lines.map((l, i) => i).filter((i) => /^\s+\S/.test(lines[i]) && !/^\s*[}\])]/.test(lines[i]) && lines[i].trim().length > 12);
    for (const [k, i] of [body[Math.floor(body.length / 3)], body[Math.floor((2 * body.length) / 3)]].entries()) {
      if (i === undefined) continue;
      const start = lines.slice(0, i).join("\n").length + (i ? 1 : 0);
      const indent = /^\s*/.exec(lines[i])![0].length;
      const cut = k === 0 ? start + indent : start + Math.floor(lines[i].length / 2);
      const lineEnd = start + lines[i].length;
      out.push({
        path: path.relative(tasksDir, f).replace(/\\/g, "/"),
        prefix: text.slice(Math.max(0, cut - 4000), cut),
        suffix: text.slice(lineEnd, lineEnd + 1500),
        expected: text.slice(cut, lineEnd),
      });
    }
  }
  return out.slice(0, n);
}

/**
 * `validate`: every task must fail as given (else it measures nothing) and, when it has a
 * `solution/`, that solution must pass the repo's own verify commands and the hidden check.
 */
async function validate(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { tasks: { type: "string", default: path.join(process.cwd(), "eval", "tasks") }, filter: { type: "string", default: "" } },
  });
  const ids = readdirSync(values.tasks!).filter((d) => existsSync(path.join(values.tasks!, d, "task.json")) && matchesFilter(d, values.filter!)).sort();
  let problems = 0;
  for (const id of ids) {
    const dir = path.join(values.tasks!, id);
    const spec = readSpec(dir);
    const withCheck = (ws: string) => {
      if (existsSync(path.join(dir, "check"))) cpSync(path.join(dir, "check"), ws, { recursive: true });
      return runCommandSync(spec.check, { cwd: ws, timeoutMs: 5 * 60_000 });
    };
    const notes: string[] = [];
    if (withCheck(prepareWorkspace(dir, id)).status === 0) notes.push("passes without any change");
    if (existsSync(path.join(dir, "solution"))) {
      const ws = prepareWorkspace(dir, id);
      cpSync(path.join(dir, "solution"), ws, { recursive: true });
      const removeList = path.join(ws, ".remove");
      if (existsSync(removeList)) {
        for (const f of readFileSync(removeList, "utf8").split(/\r?\n/).filter(Boolean)) rmSync(path.join(ws, f), { recursive: true, force: true });
        rmSync(removeList);
      }
      for (const cmd of (await loadRules(new NodeHost(ws))).verifyCommands) {
        const r = runCommandSync(cmd, { cwd: ws, timeoutMs: 5 * 60_000 });
        if (r.status !== 0) notes.push(`solution fails \`${cmd}\`: ${r.output.trim().split("\n").slice(-3).join(" | ")}`);
      }
      const c = withCheck(ws);
      if (c.status !== 0) notes.push(`solution fails the check: ${c.output.trim().split("\n").slice(-3).join(" | ")}`);
    } else notes.push("(no solution/)");
    const bad = notes.some((n) => !n.startsWith("("));
    problems += bad ? 1 : 0;
    console.log(`${bad ? "✗" : "✓"} ${id}${notes.length ? `  ${notes.join("; ")}` : ""}`);
  }
  console.log(`\n${ids.length - problems}/${ids.length} tasks valid`);
  process.exit(problems ? 1 : 0);
}

export function aggregate(rs: TaskResult[]) {
  const sum = (f: (r: TaskResult) => number) => rs.reduce((a, r) => a + f(r), 0);
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 100);
  return {
    tasks: rs.length,
    toolCallValidity: pct(sum((r) => r.modelCalls - r.invalidCalls), sum((r) => r.modelCalls)),
    /** Share of calls refused by policy (read before edit, protected tests); not invalid. */
    refused: pct(sum((r) => r.refusedCalls ?? 0), sum((r) => r.modelCalls)),
    editApply: pct(sum((r) => r.editsApplied), sum((r) => r.editCalls)),
    taskPass: pct(rs.filter((r) => r.pass).length, rs.length),
    avgSteps: Math.round((10 * sum((r) => r.steps)) / Math.max(1, rs.length)) / 10,
    avgSeconds: Math.round(sum((r) => r.ms) / Math.max(1, rs.length) / 100) / 10,
  };
}

type Summary = ReturnType<typeof aggregate>;

function previousSummary(outRoot: string, current: string): Summary | undefined {
  const dirs = readdirSync(outRoot).filter((d) => d < current && existsSync(path.join(outRoot, d, "results.json"))).sort();
  const last = dirs[dirs.length - 1];
  return last ? JSON.parse(readFileSync(path.join(outRoot, last, "results.json"), "utf8")).summary : undefined;
}

function table(s: Summary, prev?: Summary): string {
  const rows: [string, keyof Summary, string, string][] = [
    ["tool-call validity", "toolCallValidity", "%", "≥ 98%"],
    ["refused by policy", "refused", "%", ""],
    ["edit apply", "editApply", "%", "≥ 95%"],
    ["task pass", "taskPass", "%", "≥ 60%"],
    ["avg steps", "avgSteps", "", ""],
    ["avg time", "avgSeconds", "s", ""],
  ];
  const lines = [`metric               value     Δ prev    target`, `-------------------  --------  --------  ------`];
  for (const [label, key, unit, target] of rows) {
    const v = s[key];
    const d = prev && typeof prev[key] === "number" ? Math.round((v - prev[key]) * 10) / 10 : undefined;
    lines.push(`${label.padEnd(19)}  ${`${v}${unit}`.padEnd(8)}  ${(d === undefined ? "" : `${d > 0 ? "+" : ""}${d}`).padEnd(8)}  ${target}`);
  }
  return `${s.tasks} runs\n${lines.join("\n")}`;
}

/**
 * Turns trajectories into chat-format fine-tuning samples: one sample per model
 * call whose reply was a valid action, from passing runs only (by default).
 */
function exportDataset(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", default: "dataset.jsonl" },
      "include-failed": { type: "boolean", default: false },
      // Tasks (ids, comma-separated substrings) kept out of the dataset, so the eval can measure them fairly.
      exclude: { type: "string", default: "" },
    },
  });
  const excluded = values.exclude!.split(",").map((x) => x.trim()).filter(Boolean);
  const files = positionals.flatMap((p) => {
    const dir = existsSync(path.join(p, "trajectories")) ? path.join(p, "trajectories") : p;
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && !excluded.some((x) => f.startsWith(`${x}-`) || f.includes(x)))
      .map((f) => path.join(dir, f));
  });
  // A set: repeated runs of a task often make identical calls, and duplicates only overweight them.
  const out = new Set<string>();
  for (const file of files) {
    if (!values["include-failed"] && file.endsWith("-fail.jsonl")) continue;
    const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    if (events.find((e) => e.type === "run_end")?.status !== "done") continue;
    let messages: { role: string; content: string }[] = [];
    events.forEach((e, i) => {
      if (e.type !== "llm") return;
      messages = [...messages.slice(0, e.from), ...e.messages];
      const next = events.slice(i + 1).find((x) => x.type !== "compaction");
      if (next && (next.type === "invalid" || next.type === "stuck")) return;
      out.add(JSON.stringify({ messages: [...messages, { role: "assistant", content: e.response }] }));
    });
  }
  writeFileSync(values.out!, [...out].join("\n") + (out.size ? "\n" : ""));
  console.log(`${out.size} samples from ${files.length} trajectories → ${values.out}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "run") {
  run(rest).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === "fim") {
  fimBench(rest).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === "validate") {
  validate(rest).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === "export") {
  exportDataset(rest);
} else {
  console.error("usage: eval run [--filter id] [--model m] [--runs n] | eval validate [--filter id] | eval fim [--model m] [--n 40] [--cpu] | eval export [--out dataset.jsonl] [--exclude id,id] <results dir...>");
  process.exit(2);
}
