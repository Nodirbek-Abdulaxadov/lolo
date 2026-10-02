import { Budget, estimateTokens } from "../context/budget";
import { collectContext } from "../context/collectors";
import { buildRepoMap } from "../context/repoMap";
import { environmentInfo } from "../context/environment";
import { expandMentions } from "../context/mentions";
import { detectChecks, nestedProjectProblem } from "../context/projectChecks";
import { claudePermissions, listSkills, loadInstructions, skillBlock, skillMentioned, skillsFor } from "../context/claudeSetup";
import { loadRules, Rules } from "../context/rules";
import { listFiles } from "../context/repoMap";
import { SemanticIndex } from "../context/semanticIndex";
import { languageFor } from "../context/treeSitter";
import { Checkpoints } from "../edit/checkpoints";
import { EditState } from "../edit/formats";
import type { Host } from "../host/types";
import { ChatMessage, ChatResponse, LLMProvider, ProviderError } from "../providers/types";
import { formatDiagnostics } from "../tools/diagnostics";
import { MEMORY_PATH, memoryText } from "../tools/memoryTool";
import { ProcessManager } from "../tools/processes";
import { codeStillUses } from "../tools/symbolTools";
import { mentionsPath, stillReferenced } from "../tools/importPaths";
import { EXTRACT_PROMPT } from "../tools/webTools";
import type { WebConfig } from "../web/search";
import { errorContext, failureReport, lintHints, parseTestFailures } from "../tools/testReport";
import { missingUsings, projectTypes } from "../tools/missingImports";
import { relativizePaths } from "../tools/output";
import type { McpHub, McpToolDef } from "../mcp/hub";
import { selectMcpTools } from "../mcp/select";
import { Action, AgentMode, ToolRegistry } from "../tools/registry";
import type { ToolContext, ToolDef, ToolResult } from "../tools/types";
import { History, mergeConsecutive } from "./compaction";
import { claudeTool, HookOutcome, Hooks } from "./hooks";
import { statesConvention, toolNeeds } from "./needs";
import { protectTests } from "./testGuard";
import { makePlan } from "./planner";
import { PLAN_REQUEST, QUESTION_NOTE, systemPrompt, taskMessage, todoPrompt } from "./prompts";
import { TrajectoryLog } from "./trajectoryLog";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "checkpoint"; id: string }
  | { type: "plan"; todos: string[]; goal?: string }
  | { type: "todo"; index: number; status: "active" | "done" | "failed" }
  | { type: "thought"; text: string }
  | { type: "tool"; tool: string; args: Record<string, unknown>; result: ToolResult }
  | { type: "invalid"; error: string }
  | { type: "verify"; ok: boolean; output: string }
  | { type: "tokens"; prompt: number; output: number; ctx: number }
  /** Live view of the reply being generated: the thought, and in Ask mode the answer. */
  | { type: "streaming"; thought: string; answer?: string }
  | { type: "done"; result: RunResult }
  | { type: "error"; message: string };

export interface AgentDeps {
  host: Host;
  provider: LLMProvider;
  commandAllowlist: string[];
  onEvent?: (e: AgentEvent) => void;
  /** Lets the user edit the plan before execution; return undefined to cancel. */
  reviewPlan?: (todos: string[]) => Promise<string[] | undefined>;
  maxStepsPerTodo?: number;
  maxRepairs?: number;
  /** Write .agent/trajectories/<run>.jsonl (default true). */
  trajectory?: boolean;
  /** Embedding model for semantic_search (e.g. nomic-embed-text); off when unset. */
  embeddingModel?: string;
  /** Web search provider; web tools are off when unset. */
  web?: WebConfig;
  /** Connected MCP servers; their tools are offered per todo (mcp/select.ts). */
  mcp?: McpHub;
  /** Set for explore sub-runs: no nested explore. */
  nested?: boolean;
  /** Run Claude Code hooks from .claude/settings*.json and ~/.claude/settings.json (default true). */
  claudeHooks?: boolean;
  /** Offer the user's skills from ~/.claude/skills besides the workspace's (default true). */
  userSkills?: boolean;
}

/** Repositories with at least this many code files get the explore tool for vague todos. */
const LARGE_REPO_FILES = 60;

export interface RunStats {
  steps: number;
  /** Model replies requested (incl. retries): denominator for tool-call validity. */
  modelCalls: number;
  toolCalls: number;
  invalidCalls: number;
  /** Well-formed calls refused by policy (read before edit, protected tests); not counted as invalid. */
  refusedCalls: number;
  editCalls: number;
  editsApplied: number;
  /** Writes identical to the current file; excluded from editCalls. */
  noopEdits: number;
  promptTokens: number;
  outputTokens: number;
  ms: number;
}

export interface RunResult {
  status: "done" | "failed" | "cancelled" | "planned";
  summary: string;
  todos: string[];
  changed: string[];
  checkpoint?: string;
  stats: RunStats;
  logFile?: string;
}

export interface RunOptions {
  /** Earlier turns of the chat, rendered as text, so follow-up messages have context. */
  conversation?: string;
  /** Execute this plan as-is (e.g. "Run this plan" after Plan mode): no planner call, no review. */
  plan?: { goal?: string; todos: string[] };
  /** The user detached the active editor from this message. */
  excludeActiveFile?: boolean;
  /** Pasted screenshots (base64), attached to the task message for vision models. */
  images?: string[];
}

class Cancelled extends Error {}

/** Value of a (possibly unterminated) string field in partial JSON, e.g. while streaming. */
export function partialJsonString(json: string, field: string): string | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (!m) return undefined;
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) =>
    e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16)) : e === "n" ? "\n" : e === "t" ? "\t" : e,
  ).replace(/\\$/, "");
}

/** Whether `todo` asks to run exactly `command` (named in backticks) and nothing else. */
export function commandTodo(todo: string, command: string): boolean {
  const named = [...todo.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (named.length !== 1) return false;
  const norm = (c: string) => c.replace(/\s+/g, " ").trim();
  if (norm(named[0]) !== norm(command)) return false;
  // "Run `x` to create the project" is the whole todo; "Run `x`, then add ..." is not.
  const rest = todo.replace(/`[^`]+`/, "").replace(/\b(run|execute|use|with|the|command|in|to|create|the project|a new project|initialize|generate|install|add)\b/gi, "");
  return !/\b(then|and|also|after|edit|update|implement|write|change|fix)\b/i.test(rest);
}

/**
 * The later todo the failing checks are about, if any: a name from the error lines
 * (`SystemClock`, `IClock`, `computeTax`, `Program.cs`) that a later todo mentions. Only
 * code-like names count: an inner capital (camelCase, PascalCase with two capitals),
 * snake_case, or a source file name; error/exception class names don't.
 */
export function laterTodoFor(failure: string, later: string[]): string | undefined {
  if (!later.length) return undefined;
  const errorLines = failure.split("\n").filter((l) => /error|fail|✖|×|Traceback|Exception/i.test(l));
  const codeName = (w: string) =>
    w.length >= 4 &&
    !/(Error|Exception|Warning)$/.test(w) &&
    (/\.(cs|tsx?|jsx?|mjs|cjs|py|go|java|rs|rb|php|kt)$/.test(w) || (/[A-Z]/.test(w.slice(1)) && /[a-z]/.test(w)) || /[a-z]_[a-z]/i.test(w));
  const names = new Set(errorLines.flatMap((l) => l.match(/[A-Za-z_]\w*(?:\.(?:cs|tsx?|jsx?|mjs|cjs|py|go|java|rs|rb|php|kt)\b)?/g) ?? []).filter(codeName));
  return later.find((t) => [...names].some((n) => new RegExp(`(?<![\\w.])${n.replace(/[.$]/g, "\\$&")}(?![\\w])`).test(t)));
}

/** "server: tool, tool" per MCP server, for the system prompt. */
function mcpSummary(tools: McpToolDef[]): string {
  const byServer = new Map<string, string[]>();
  for (const t of tools) byServer.set(t.mcp.server, [...(byServer.get(t.mcp.server) ?? []), t.mcp.tool]);
  return [...byServer].map(([server, names]) => `- ${server}: ${names.slice(0, 30).join(", ")}${names.length > 30 ? ", ..." : ""}`).join("\n");
}

/** A Stop hook may send the run back to work this many times. */
const MAX_STOP_BLOCKS = 2;
/** Stop and ask the user after this many consecutive failed or invalid steps. */
const MAX_CONSECUTIVE_FAILURES = 4;
/**
 * Whether the reply so far ends with the same line, or the same block of up to 8 lines, many
 * times in a row (qwen2.5-coder repeated a comment, a commented-out `return` and a blank line
 * until the token limit). Lines are split on real line breaks and on `\n` escapes, since file
 * content inside the JSON reply is escaped.
 */
export function repeatsLine(text: string, times = 16): boolean {
  const lines = text.split(/\\n|\n/).slice(0, -1); // the last one may still be growing
  if (cycles(lines, 1, (p) => Math.max(times, p * 6))) return true;
  // The same shape with other names: `function calculateTaxFromItems(items) { return items.reduce(...) }`
  // for every combination the model can think of. Only blocks, repeated at length (similar one-liners
  // such as constant tables are normal code).
  const shapes = lines.map((l) => l.replace(/[A-Za-z_$][\w$]*/g, "x").replace(/\d+(\.\d+)?/g, "0"));
  return cycles(shapes, 2, (p) => Math.max(40, p * 10));
}

/** Whether `lines` end with a block of `minPeriod`..8 lines repeated over at least `length(period)` lines. */
function cycles(lines: string[], minPeriod: number, length: (period: number) => number): boolean {
  for (let period = minPeriod; period <= 8; period++) {
    const n = length(period);
    if (lines.length < n) break;
    const tail = lines.slice(-n);
    const block = tail.slice(0, period);
    // A block needs real content: `}` or a/b alternating lines are not a loop; a block of one repeated
    // line is left to period 1 (for shapes, a table of one-liners).
    if (block.join("").replace(/\s/g, "").length < (period === 1 ? 3 : 8) || (period > 1 && new Set(block).size < 2)) continue;
    if (tail.every((l, i) => l === block[i % period])) return true;
  }
  return false;
}

/** Tools whose written content the model wrote itself (so it has "seen" the file afterwards). */
const MODEL_WRITES = new Set(["edit", "rewrite_file", "edit_lines", "create_file"]);

/** A thought longer than this (characters) before any action is cut off; the schema allows THOUGHT_MAX. */
const THOUGHT_ABORT = 1500;
/** Consecutive reads (agent mode) after which the model is reminded to act. */
const READS_BEFORE_NUDGE = 5;
/** Extra attempts after a model generation failure. */
const MODEL_RETRIES = 2;

export class Agent {
  /** Replaced at the start of each run, when MCP tools are known. */
  private registry = new ToolRegistry();

  constructor(private readonly deps: AgentDeps) {}

  async run(task: string, mode: AgentMode, signal?: AbortSignal, opts: RunOptions = {}): Promise<RunResult> {
    const { host, provider } = this.deps;
    const profile = provider.profile;
    const started = Date.now();
    const stats: RunStats = { steps: 0, modelCalls: 0, toolCalls: 0, invalidCalls: 0, refusedCalls: 0, editCalls: 0, editsApplied: 0, noopEdits: 0, promptTokens: 0, outputTokens: 0, ms: 0 };
    const changed = new Set<string>();
    const emit = (e: AgentEvent) => this.deps.onEvent?.(e);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const log = this.deps.trajectory === false ? undefined : new TrajectoryLog(host.root, runId);
    let todos: string[] = [];
    let checkpoint: string | undefined;

    const processes = new ProcessManager(host.root);
    const finish = (status: RunResult["status"], summary: string): RunResult => {
      void processes.stopAll();
      stats.ms = Date.now() - started;
      const result: RunResult = { status, summary, todos, changed: [...changed], checkpoint, stats, logFile: log?.file };
      log?.write("run_end", { status, summary, changed: result.changed, stats });
      emit({ type: "done", result });
      return result;
    };

    try {
      log?.write("run_start", { task, mode, model: provider.model, profile });

      if (opts.images?.length && (await provider.supportsImages?.()) === false) {
        return finish("failed", `${provider.model} can't read images. Pick a vision model (e.g. qwen3.5:9b) in the model menu, or describe the problem in text.`);
      }
      // 2. Context: stable parts go into the system message, per-run parts into the task message.
      emit({ type: "status", text: "Collecting context" });
      const budget = Budget.for(profile);
      const rules = await loadRules(host);
      // Claude Code setups: CLAUDE.md/AGENTS.md, skills, permissions (context/claudeSetup.ts).
      const instructions = await loadInstructions(host);
      const skills = await listSkills(host, this.deps.userSkills === false ? null : undefined);
      const wanted = skillsFor(task, skills);
      // A short follow-up ("och", "open it", "do it") continues the request before it: its skill still applies.
      if (!wanted.length && opts.conversation && task.trim().length <= 60) {
        const earlier = [...opts.conversation.matchAll(/^User: (.*)$/gm)].map((m) => m[1]).slice(-3).reverse();
        wanted.push(...(earlier.map((m) => skillsFor(m, skills)).find((w) => w.length) ?? []));
      }
      if (wanted.length) log?.write("skills", { names: wanted.map((s) => s.name) });
      const perms = await claudePermissions(host);
      const hooks = this.deps.claudeHooks === false || this.deps.nested ? Hooks.empty(host.root) : await Hooks.load(host);
      const session = { session_id: runId, transcript_path: log?.file ?? "" };
      const warned = new Set<string>();
      const hookNotes = (event: string, r: HookOutcome) => {
        // Once per run: a hook that can't run here (powershell on Linux) would repeat after every command.
        for (const w of r.warnings) if (!warned.has(w)) warned.add(w), emit({ type: "status", text: w });
        if (r.block || r.context.length || r.warnings.length) log?.write("hook", { event, block: r.block, context: r.context, warnings: r.warnings });
      };
      let hookContext = "";
      if (hooks.has("UserPromptSubmit")) {
        emit({ type: "status", text: "Running UserPromptSubmit hooks" });
        const r = await hooks.run("UserPromptSubmit", { ...session, prompt: task }, undefined, signal);
        hookNotes("UserPromptSubmit", r);
        if (r.block) return finish("cancelled", `A UserPromptSubmit hook blocked this message: ${r.block}`);
        if (r.context.length) hookContext = `From the project's hooks:\n${r.context.join("\n\n")}`;
      }
      const memory = (await host.stat(MEMORY_PATH)) === "file" ? memoryText(await host.readFile(MEMORY_PATH)) : "";
      const editorRaw = await host.editorContext?.();
      const editor = editorRaw && opts.excludeActiveFile ? { ...editorRaw, activeFile: undefined } : editorRaw;
      const mentions = await expandMentions(host, task, Math.floor(budget.tokens("files") / 3), { terminalOutput: editor?.terminalOutput, web: this.deps.web, mcp: this.deps.mcp });
      const focus = [...mentions.files, editor?.activeFile?.path, ...(editor?.openTabs ?? [])].filter((p): p is string => !!p);
      const repoMap = await buildRepoMap(host, budget.tokens("map"), focus, task);
      const mcp = this.deps.mcp;
      if (mcp?.size) {
        emit({ type: "status", text: "Starting MCP servers" });
        await mcp.ready();
        for (const st of mcp.status().filter((x) => !x.ok)) emit({ type: "status", text: `MCP server "${st.name}" is not available: ${st.error}` });
      }
      const mcpTools = mcp?.tools() ?? [];
      this.registry = new ToolRegistry(mcpTools);
      const embedModel = this.deps.embeddingModel;
      const semantic = embedModel && provider.embed ? new SemanticIndex(host, embedModel, (texts, sig) => provider.embed!(texts, embedModel, sig)) : undefined;
      const modeTools = this.registry.all.filter(
        (t) =>
          (mode === "agent" || t.kind === "read" || t.kind === "control") &&
          !t.group &&
          (!t.available || t.available({ semantic } as ToolContext)) &&
          (t.name !== "done" || mode !== "ask"),
      );
      const system = systemPrompt({ mode, model: provider.model, toolMode: profile.toolMode, environment: await environmentInfo(host.shell), toolList: this.registry.describe(modeTools), mcp: mcpSummary(mcpTools), rules: budget.fit("rules", rules.text), memory: budget.fit("rules", memory), instructions: { text: budget.fit("instructions", instructions.text), sources: instructions.sources }, skills: skills.map((s) => `- ${s.name} (${s.path}): ${s.summary}`).join("\n"), verifyCommands: rules.verifyCommands, repoMap });
      const collected = await collectContext(host, editor, Math.floor(budget.tokens("files") / 3));
      const context = [mentions.context, collected, budget.fit("instructions", hookContext)].filter(Boolean).join("\n\n");
      const prefix: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: taskMessage(task, context, opts.conversation, wanted.map((s) => budget.fit("files", skillBlock(s), Math.floor(budget.tokens("files") / 2)))), ...(opts.images?.length ? { images: opts.images } : {}) },
      ];
      const history = new History();

      // 3. Plan. The planner also classifies the message: chat → reply, question → read-only answer, task → todos.
      let execMode = mode;
      if (mode === "ask") {
        todos = [task];
      } else if (opts.plan?.todos.length) {
        // Preset plan: recorded as if the planner produced it, so the history format is unchanged.
        todos = opts.plan.todos.slice(0, 6);
        const content = JSON.stringify({ kind: "task", reply: "", goal: opts.plan.goal ?? "", todos });
        history.setPreamble([{ role: "user", content: PLAN_REQUEST }, { role: "assistant", content }]);
        history.note(todoPrompt(0, todos));
        emit({ type: "plan", todos, goal: opts.plan.goal });
      } else {
        emit({ type: "status", text: "Planning" });
        const plan = await makePlan(provider, prefix, signal, task);
        log?.llm("plan", [...prefix, plan.messages[0]], plan.messages[1].content, plan.raw.trim() !== plan.messages[1].content ? { raw: plan.raw } : {});
        log?.write("classified", { kind: plan.kind });
        if (plan.kind === "chat") return finish("done", plan.reply);
        if (plan.kind === "question") {
          execMode = "ask";
          todos = [task];
          history.setPreamble(plan.messages);
          history.note(QUESTION_NOTE);
          emit({ type: "status", text: "Answering" });
        } else {
          todos = plan.todos;
          // The user asked for a skill but the plan ignores it (7B models do): its steps come first.
          const missing = wanted.filter((sk) => !todos.some((t) => skillMentioned(t, sk)));
          if (missing.length) {
            todos = [...missing.map((sk) => `Do what the ${sk.name} skill says for this request: ${sk.summary}`), ...todos].slice(0, 6);
            plan.messages[1] = { role: "assistant", content: JSON.stringify({ goal: plan.goal, kind: plan.kind, reply: "", todos }) };
          }
          emit({ type: "plan", todos, goal: plan.goal });
          if (mode === "plan") return finish("planned", todos.map((t, i) => `${i + 1}. ${t}`).join("\n"));
          const reviewed = this.deps.reviewPlan ? await this.deps.reviewPlan(todos) : todos;
          if (!reviewed?.length) return finish("cancelled", "Plan rejected.");
          if (reviewed.join("\n") !== todos.join("\n")) {
            todos = reviewed;
            plan.messages[1] = { role: "assistant", content: JSON.stringify({ kind: plan.kind, reply: "", goal: plan.goal, todos }) };
            emit({ type: "plan", todos });
          }
          history.setPreamble(plan.messages);
          history.note(todoPrompt(0, todos));
        }
      }

      // Checkpoint before anything can write (only once the message turned out to be a task).
      if (execMode === "agent") {
        try {
          checkpoint = (await new Checkpoints(host.root).create(`before: ${task.slice(0, 100)}`)).id;
          emit({ type: "checkpoint", id: checkpoint });
        } catch (e) {
          const go = await host.confirm(`Could not create a checkpoint (${(e as Error).message.split("\n")[0]}). Continue without one?`);
          if (!go) return finish("cancelled", "No checkpoint; run cancelled.");
        }
      }

      // 4. Execute todos.
      const ctx: ToolContext = { host, profile, edits: new EditState(), commandAllowlist: [...this.deps.commandAllowlist, ...perms.allow], commandDeny: perms.deny, signal, readOnly: execMode === "ask", processes, semantic,
        web: this.deps.web,
        message: task,
        protectTests: protectTests(task),
        // @-mentioned files are in the task message; everything else must be read before it is edited.
        seen: new Set(mentions.files),
        largeRepo: !this.deps.nested && (await listFiles(host)).filter((f) => languageFor(f)).length >= LARGE_REPO_FILES,
        explore: this.deps.nested ? undefined : (question, sig) => this.explore(question, emit, sig),
        extract: (text, question, sig) => this.extract(text, question, stats, sig),
      };
      const summaries: string[] = [];
      const checksPending = { value: false };
      let stops = 0;
      for (let i = 0; i < todos.length; i++) {
        emit({ type: "todo", index: i, status: "active" });
        const outcome = await this.runTodo(i, todos, execMode, { prefix, history, ctx, rules, budget, stats, changed, emit, log, signal, task, checksPending, hooks, session, hookNotes });
        if (!outcome.ok) {
          emit({ type: "todo", index: i, status: "failed" });
          return finish("failed", [...summaries, `Stopped at todo ${i + 1} (${todos[i]}): ${outcome.summary}`].join("\n"));
        }
        emit({ type: "todo", index: i, status: "done" });
        summaries.push(execMode === "ask" || todos.length === 1 ? outcome.summary : `${i + 1}. ${outcome.summary}`);
        if (i + 1 < todos.length) history.note(todoPrompt(i + 1, todos));
        else if (execMode === "agent" && stops < MAX_STOP_BLOCKS && hooks.has("Stop")) {
          // A Stop hook may say the work isn't finished (tests fail, a step was skipped): that becomes a todo.
          const r = await hooks.run("Stop", { ...session, stop_hook_active: stops > 0 }, undefined, signal);
          hookNotes("Stop", r);
          if (r.block) {
            stops++;
            todos.push(`Fix what the project's Stop hook reported: ${r.block.split("\n")[0].slice(0, 200)}`);
            emit({ type: "plan", todos });
            history.note(`The project's Stop hook says the work is not finished:\n${r.block}\n\n${todoPrompt(i + 1, todos)}`);
          }
        }
      }
      return finish("done", summaries.join("\n"));
    } catch (e) {
      if (e instanceof Cancelled || signal?.aborted || (e as Error).name === "AbortError") return finish("cancelled", "Cancelled.");
      emit({ type: "error", message: (e as Error).message });
      log?.write("error", { message: (e as Error).message, stack: (e as Error).stack });
      return finish("failed", `Error: ${(e as Error).message}`);
    }
  }

  private async runTodo(
    index: number,
    todos: string[],
    mode: AgentMode,
    s: {
      prefix: ChatMessage[];
      history: History;
      ctx: ToolContext;
      rules: Rules;
      budget: Budget;
      stats: RunStats;
      changed: Set<string>;
      emit: (e: AgentEvent) => void;
      log?: TrajectoryLog;
      signal?: AbortSignal;
      /** The user's message (web access is decided from it, too). */
      task: string;
      /** Checks failed at an earlier todo and were deferred: they run at every done until they pass. */
      checksPending: { value: boolean };
      hooks: Hooks;
      session: Record<string, unknown>;
      hookNotes: (event: string, r: HookOutcome) => void;
    },
  ): Promise<{ ok: boolean; summary: string }> {
    const { history, ctx, stats, emit, log } = s;
    const { host } = this.deps;
    const maxSteps = this.deps.maxStepsPerTodo ?? 15;
    const maxRepairs = this.deps.maxRepairs ?? 3;
    // A later todo of a rename rename_symbol already did everywhere (planners split renames per file).
    const renamed = [...(ctx.renamed ?? [])].find(([from]) => new RegExp(`\\b${from.replace(/\$/g, "\\$")}\\b`).test(todos[index]));
    if (renamed && /renam|replace|update/i.test(todos[index]) && !(await codeStillUses(ctx, renamed[0]))) {
      history.note(`Todo ${index + 1} was already done by renaming ${renamed[0]} to ${renamed[1]} everywhere.`);
      log?.write("todo_done", { index, summary: "already done by rename_symbol", auto: "rename" });
      return { ok: true, summary: `Already done: ${renamed[0]} was renamed to ${renamed[1]} everywhere.` };
    }
    // A later todo that updates the imports of a file move_file already moved (planners split "move X" into move + fix imports).
    // Also a later todo that restates the move itself ("Move the content of a.py to b.py"): the model moved the file back.
    const moved = [...(ctx.moved ?? [])].find(([from, to]) => mentionsPath(todos[index], from) || mentionsPath(todos[index], to));
    if (moved && /\b(import|require|reference|usage|use|point|update|fix|mov(e|ing)|content|cop(y|ies)|creat\w*)/i.test(todos[index]) && !(await stillReferenced(ctx, moved[0]))) {
      history.note(`Todo ${index + 1} was already done: move_file updated every import of ${moved[0]} (now ${moved[1]}).`);
      log?.write("todo_done", { index, summary: "already done by move_file", auto: "move" });
      return { ok: true, summary: `Already done: the imports of ${moved[0]} were updated when it moved to ${moved[1]}.` };
    }
    // Optional tool groups (git, file moves) are offered only to todos that mention them.
    // Questions are read-only already: explore would only add a second run.
    ctx.needs = toolNeeds(todos[index], s.task, { largeRepo: ctx.largeRepo && mode === "agent" });
    ctx.todo = todos[index];
    ctx.mcpTools = selectMcpTools(this.registry.all.filter((t): t is McpToolDef => t.group === "mcp"), todos[index], s.task);
    const extra = this.registry.enabled(mode, ctx).filter((t) => t.group && t.group !== "symbols");
    if (extra.length) history.note(`Extra tools for this todo:\n${this.registry.describe(extra)}`);
    // A convention said in passing: offered to memory once, at the last todo; the user reviews the write.
    if (mode === "agent" && index === todos.length - 1 && statesConvention(s.task) && extra.some((t) => t.name === "remember")) {
      history.note("The user's message states a lasting convention of this project. After the work, if it isn't in the project memory yet, save it with remember (one sentence); the user reviews it.");
    }
    if (ctx.needs.has("web") && !ctx.web && /(^|\s)@web\b/.test(s.task)) {
      history.note("Web access is off, so you cannot search the web. Answer from the code and what you know, and tell the user that web search can be enabled in the setting localAgent.web.search.");
    }
    let repairs = 0;
    let failures = 0;
    let repeats = 0;
    // Calls made since the last successful write; a repeat within this window is a loop
    // (catches A-B-A-B cycles, while re-reading a file after editing it stays allowed).
    let seen = new Set<string>();
    let changedInTodo = false;
    let noopStreak = 0;
    /** Consecutive read-only calls in agent mode; small models keep reading instead of editing. */
    let readStreak = 0;
    /** Write calls that were applied in this todo (identical repeats are loops). */
    const appliedWrites = new Set<string>();
    /** Project checks after this todo changed files: true when they pass (or, if allowed, when there are none). */
    const checksPass = async (allowNoChecks: boolean) => {
      if (!changedInTodo) return false;
      const checks = s.rules.verifyCommands.length ? s.rules.verifyCommands : await detectChecks(host);
      if (!checks.length) return allowNoChecks;
      return !(await this.verify(checks, emit, (files) => files.forEach((f) => s.changed.add(f)), ctx.seen));
    };
    const completeAuto = (why: string) => {
      const summary = `Completed: ${todos[index]}.`;
      log?.write("todo_done", { index, summary, auto: why });
      return { ok: true, summary };
    };
    /**
     * The model is stuck. Small models often keep "improving" after the work is done,
     * so first check the result: if the checks pass the todo is complete. Otherwise
     * ask the user (interactive hosts) or give up.
     */
    /** Question mode, stuck: the model has usually read enough but keeps looking. Only `answer` is offered from now on. */
    let answerNow = false;
    /**
     * Agent mode, stuck while only looking (git_diff, git_blame, read_file, search in a circle): it has
     * seen the code but doesn't dare to change it. Once per todo, only the file-writing tools are offered
     * until a write applies.
     */
    let writeNow = false;
    let forcedWrite = false;
    /** No write was attempted (even a refused one) since the last write that applied. */
    let onlyLooking = true;
    const onStuck = async (problem: string, failSummary: string) => {
      if (await checksPass(false)) return completeAuto("stuck, but checks pass");
      if (mode === "ask" && !answerNow) {
        answerNow = true;
        failures = 0;
        repeats = 0;
        log?.write("stuck", { forceAnswer: true });
        history.note("Stop looking: you have what you need. Call answer now with the best answer from what you found above.");
        return undefined;
      }
      // Only before the todo changed anything: after a change, a forced write is a guess (qwen3.5 removed a working `return`).
      if (mode === "agent" && onlyLooking && !changedInTodo && !forcedWrite && !/^\s*(run|execute|verify|check|test|start)\b/i.test(todos[index])) {
        writeNow = forcedWrite = true;
        failures = 0;
        repeats = 0;
        seen = new Set();
        log?.write("stuck", { forceWrite: true });
        history.note("Stop looking: you have read the code this todo is about. Make the change now: edit the file (or rewrite it) with your best fix.");
        return undefined;
      }
      const go = await this.unstick(index, todos, history, problem);
      failures = 0;
      repeats = 0;
      seen = new Set();
      return go ? undefined : { ok: false, summary: failSummary };
    };
    // History may use what the window leaves after the fixed prefix and the output reserve.
    const prefixTokens = s.prefix.reduce((n, m) => n + estimateTokens(m.content), 0);
    const historyBudget = Math.min(s.budget.conversation, s.budget.ctx - s.budget.tokens("output") - prefixTokens);

    // The limit grows while the todo keeps making progress (edits apply): one broad todo such as
    // "create the project" can legitimately need more steps; a stuck one doesn't get them.
    let stepLimit = maxSteps;
    let lastProgress = -1;
    let lastFailure = -1;
    for (let step = 0; step < stepLimit; step++) {
      if (s.signal?.aborted) throw new Cancelled();
      // Progress = edits apply and nothing failed lately (edit → failing build → edit is thrashing, not progress).
      if (step === stepLimit - 1 && step - lastProgress <= 3 && step - lastFailure > 3 && stepLimit < maxSteps * 3) stepLimit += 5;
      // Question mode, last steps: answer from what was read instead of failing with nothing.
      if (mode === "ask" && !answerNow && step === stepLimit - 2) {
        answerNow = true;
        log?.write("stuck", { forceAnswer: true, stepLimit });
        history.note("Stop looking: you are out of steps. Call answer now with the best answer from what you found above.");
      }
      stats.steps++;

      const compacted = history.compactIfNeeded(historyBudget);
      if (compacted) log?.write("compaction", { turns: compacted });

      const forced = (t: ToolDef) => (!answerNow || t.name === "answer") && (!writeNow || MODEL_WRITES.has(t.name));
      const enabled = this.registry.enabled(mode, ctx).filter(forced);
      // Built exactly like the planner call, so the planner's prefix is reused from the KV cache.
      const messages = mergeConsecutive([...s.prefix, ...history.messages()]);
      const t0 = Date.now();
      const res = await this.callModel(messages, enabled, stats, emit, s.signal);
      stats.promptTokens += res.promptTokens ?? 0;
      stats.outputTokens += res.outputTokens ?? 0;
      emit({ type: "tokens", prompt: res.promptTokens ?? 0, output: res.outputTokens ?? 0, ctx: ctx.profile.ctx });
      log?.llm("step", messages, res.content, { ms: Date.now() - t0, promptTokens: res.promptTokens, outputTokens: res.outputTokens, tools: enabled.map((t) => t.name) });

      if (res.degenerate) {
        stats.invalidCalls++;
        failures++;
        const advice = res.longThought
          ? "Your thought was far too long and was cut off. Keep it to one or two sentences, then give the tool call."
          : "Your reply degenerated into repeating itself and was cut off. Take a smaller step: change a few lines with edit instead of rewriting a whole file.";
        emit({ type: "invalid", error: "model output degenerated; asked for a smaller step" });
        history.add("(no reply)", advice, "reply degenerated");
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          const end = await onStuck("the model's replies keep degenerating", "the model's replies keep degenerating");
          if (end) return end;
        }
        continue;
      }
      // Parse + validate.
      const parsed = this.registry.parse(res.content);
      if ("error" in parsed) {
        stats.invalidCalls++;
        failures++;
        emit({ type: "invalid", error: parsed.error });
        const example = this.registry.render({ thought: "why", tool: "read_file", args: { path: "src/a.ts" } }, ctx.profile.toolMode);
        history.add(res.content, `Error: ${parsed.error} Reply with exactly one tool call, e.g.:\n${example}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          const end = await onStuck(parsed.error, "too many invalid replies");
          if (end) return end;
        }
        continue;
      }
      const action: Action = parsed.action;
      // History keeps the mode's own format: models imitate whatever format they see there.
      const assistant = this.registry.render(action, ctx.profile.toolMode);
      if (action.thought) emit({ type: "thought", text: action.thought });
      stats.toolCalls++;

      // The model asked for a hidden optional tool by name (e.g. start_process): that is the
      // clearest signal it needs it, so offer its group instead of rejecting the call.
      let offered = enabled;
      if (!enabled.some((t) => t.name === action.tool)) {
        const wanted = this.registry.all.find((t) => t.name === action.tool);
        if (wanted?.group && this.unlockGroup(wanted, ctx)) {
          offered = this.registry.enabled(mode, ctx).filter(forced);
          if (offered.includes(wanted)) log?.write("unlocked", { tool: wanted.name, group: wanted.group });
        }
      }
      const checked = await this.registry.check(action, offered, ctx);
      if (this.registry.all.find((t) => t.name === action.tool)?.kind === "write") onlyLooking = false;
      if (!checked.ok) {
        if (checked.policy) stats.refusedCalls++;
        else stats.invalidCalls++;
        failures++;
        emit({ type: "invalid", error: checked.error });
        log?.write("invalid", { action, error: checked.error });
        history.add(assistant, `Error: ${checked.error}`, `${action.tool}: rejected (${checked.error.split(".")[0]})`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          const end = await onStuck(checked.error, "too many failed steps");
          if (end) return end;
        }
        continue;
      }
      const { tool, args } = checked;

      // Stuck detection: a call already made since the last write → switch strategy instead of executing it again.
      // An identical write that was already applied in this todo counts too (an "append" edit repeated forever).
      const key = tool.name + JSON.stringify(args, Object.keys(args).sort());
      const rewrite = appliedWrites.has(key);
      if (seen.has(key) || rewrite) {
        repeats++;
        let msg = rewrite
          ? "You already made exactly this change and it was applied: the file contains it now. If the todo is complete, call done; otherwise do the next step."
          : "You already made exactly this call and got its result above. Do something different.";
        if (!rewrite && tool.kind === "write" && typeof args.path === "string") {
          ctx.edits.forceLineRange(args.path);
          msg += ` ${args.path} is now in line mode: read_file shows line numbers, then use edit_lines.`;
        }
        log?.write("stuck", { action, repeats });
        history.add(assistant, msg, `${tool.name}: repeated`);
        if (repeats >= 3) {
          const end = await onStuck("repeating the same actions", "stuck repeating the same actions");
          if (end) return end;
        }
        continue;
      }
      seen.add(key);

      // Claude Code PreToolUse hooks: may refuse the call (the reason goes to the model) or approve it.
      const asClaude = tool.kind === "control" ? undefined : claudeTool(tool.name, args, host.root, (tool as McpToolDef).mcp);
      ctx.preApproved = false;
      if (asClaude && s.hooks.has("PreToolUse", asClaude.name)) {
        const r = await s.hooks.run("PreToolUse", { ...s.session, tool_name: asClaude.name, tool_input: asClaude.input }, asClaude.name, s.signal);
        s.hookNotes("PreToolUse", r);
        if (r.block) {
          stats.refusedCalls++;
          failures++;
          emit({ type: "invalid", error: `blocked by a PreToolUse hook: ${r.block}` });
          history.add(assistant, `Not run: the project's PreToolUse hook blocked this call:\n${r.block}`, `${tool.name}: blocked by hook`);
          continue;
        }
        ctx.preApproved = !!r.allow;
      }

      // done: verify the todo's changes before accepting.
      if (tool.name === "done" || tool.name === "answer") {
        const summary = String(args.summary ?? args.text);
        // Checks from rules, else inferred from project files (detected now, so projects created in this run count).
        const checks = changedInTodo || s.checksPending.value ? (s.rules.verifyCommands.length ? s.rules.verifyCommands : await detectChecks(host)) : [];
        if (checks.length) {
          const failed = await this.verify(checks, emit, (files) => files.forEach((f) => s.changed.add(f)), ctx.seen);
          // Mid-plan, the build may not pass yet: Greeter takes an IClock (todo 1) before SystemClock
          // implements it (todo 2). When the errors are about what a later todo does, check after that one.
          const later = failed ? laterTodoFor(failed, todos.slice(index + 1)) : undefined;
          if (failed && later !== undefined) {
            s.checksPending.value = true;
            log?.write("verify", { ok: false, deferred: later });
            history.add(assistant, `Todo complete. The checks don't pass yet, but the errors are about what a later todo does ("${later}"); they run again after it.`, `done: ${summary.slice(0, 120)} (checks deferred)`);
            log?.write("todo_done", { index, summary, deferred: true });
            return { ok: true, summary };
          }
          if (failed) {
            repairs++;
            lastFailure = step;
            log?.write("verify", { ok: false, repairs });
            if (repairs > maxRepairs) return { ok: false, summary: `verification still failing after ${maxRepairs} repair attempts` };
            history.add(assistant, `Not done yet: verification failed.\n${failed}\nFix the cause (attempt ${repairs}/${maxRepairs}), then call done again.`, "done: verification failed");
            continue;
          }
          log?.write("verify", { ok: true });
          s.checksPending.value = false;
        }
        history.add(assistant, "Todo complete.", `done: ${summary.slice(0, 120)}`);
        log?.write("todo_done", { index, summary });
        return { ok: true, summary };
      }

      // Execute.
      if (tool.kind === "write") {
        stats.editCalls++;
        // Re-reading after any write attempt (even a rejected one) is legitimate.
        for (const k of seen) if (k.startsWith("read_file")) seen.delete(k);
      }
      ctx.thought = action.thought;
      const result = await tool.run(args, ctx);
      if (result.ok && (tool.name === "read_file" || tool.name === "read_symbol") && typeof args.path === "string") ctx.seen?.add(args.path);
      // Only the model's own writes count as seen: files changed by code (import updates of a move) it hasn't seen.
      if (MODEL_WRITES.has(tool.name)) result.changed?.forEach((f) => ctx.seen?.add(f));
      if (result.noop) {
        stats.editCalls--;
        stats.noopEdits++;
        noopStreak++;
      } else if (tool.kind === "write") {
        noopStreak = 0;
      }
      log?.write("tool", { tool: tool.name, args, ok: result.ok, summary: result.summary, changed: result.changed });
      emit({ type: "tool", tool: tool.name, args, result });
      failures = result.ok ? 0 : failures + 1;
      if (!result.ok && !result.noop) lastFailure = step;

      let observation = result.output;
      ctx.preApproved = false;
      // Claude Code PostToolUse hooks (after a successful call): their feedback goes to the model.
      if (asClaude && result.ok && s.hooks.has("PostToolUse", asClaude.name)) {
        emit({ type: "status", text: `Running PostToolUse hooks for ${asClaude.name}` });
        const response = asClaude.name === "Bash" ? { stdout: result.output, stderr: "", interrupted: false } : { success: true, output: result.output.slice(0, 20000) };
        const r = await s.hooks.run("PostToolUse", { ...s.session, tool_name: asClaude.name, tool_input: asClaude.input, tool_response: response }, asClaude.name, s.signal);
        s.hookNotes("PostToolUse", r);
        if (r.block) {
          lastFailure = step;
          emit({ type: "verify", ok: false, output: r.block });
          observation += `\n\nThe project's PostToolUse hook reported a problem:\n${r.block}`;
        }
        if (r.context.length) observation += `\n\n${r.context.join("\n")}`;
      }
      if (result.changed?.length) {
        // run_command may change files too (added using directives): not an edit call of the model.
        if (tool.kind === "write") {
          stats.editsApplied++;
          appliedWrites.add(key);
          writeNow = false;
          onlyLooking = true;
        }
        lastProgress = step;
        // Agent files (.agent/memory.md) don't need the project's build/tests.
        if (result.changed.some((f) => !f.startsWith(".agent/"))) changedInTodo = true;
        result.changed.forEach((f) => s.changed.add(f));
        seen = new Set();
        if (s.rules.afterEdit.length) observation += await this.runAfterEdit(s.rules.afterEdit, result.changed);
        // Verify: fresh diagnostics for the files just written.
        const errors = (await host.diagnostics(result.changed)).filter((d) => d.severity === "error");
        if (errors.length) {
          repairs++;
          lastFailure = step;
          emit({ type: "verify", ok: false, output: formatDiagnostics(errors) });
          if (repairs > maxRepairs) return { ok: false, summary: `errors remain after ${maxRepairs} repair attempts:\n${formatDiagnostics(errors, 10)}` };
          observation += `\n\nThe change introduced errors (repair attempt ${repairs}/${maxRepairs}):\n${formatDiagnostics(errors)}`;
        } else {
          repairs = 0;
        }
      }
      readStreak = mode === "agent" && tool.kind === "read" ? readStreak + 1 : 0;
      if (readStreak === READS_BEFORE_NUDGE) {
        observation += `\n\n[That is ${READS_BEFORE_NUDGE} reads in a row. If you know what to change, change it now; read only what is still missing.]`;
      }
      history.add(assistant, observation, result.summary);
      // A todo that is just "Run `cmd`" is done once that command succeeded; small models
      // otherwise carry on with the next todos inside this one and lose track of the plan.
      // Only with todos left: when the plan squeezed the whole task into this one, the model must go on.
      if (tool.name === "run_command" && result.ok && index < todos.length - 1 && commandTodo(todos[index], String(args.command))) {
        return completeAuto("its command succeeded");
      }
      // The model keeps "editing" without changing anything: the work is likely done but it
      // doesn't know. Check it ourselves and close the todo if the checks pass.
      if (noopStreak >= 2) {
        noopStreak = 0;
        if (await checksPass(true)) return completeAuto("no-op edits, checks pass");
      }
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        const end = await onStuck(result.summary, "too many failed steps");
        if (end) return end;
      }
    }
    // Out of steps, like stuck: work that passes the checks is done, the model just didn't say so.
    if (await checksPass(false)) return completeAuto("out of steps, but checks pass");
    return { ok: false, summary: `no result after ${stepLimit} steps` };
  }

  /**
   * One model call. Generation failures (e.g. Ollama aborting a repetition loop) are
   * retried at a higher temperature; HTTP/connection errors are not.
   */
  private async callModel(
    messages: ChatMessage[],
    enabled: ToolDef[],
    stats: RunStats,
    emit: (e: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse & { degenerate?: boolean; longThought?: boolean }> {
    const { provider } = this.deps;
    const mode = provider.profile.toolMode;
    const schema = mode === "schema" ? this.registry.actionSchema(enabled) : undefined;
    const tools = mode === "native" ? this.registry.toolSpecs(enabled) : undefined;
    for (let attempt = 0; ; attempt++) {
      let partial = "";
      let lastEmit = 0;
      // A thought that keeps growing before any action (qwen3.5 reasoning until the token limit) is stopped early.
      const guard = new AbortController();
      let longThought = false;
      // A reply that repeats one line over and over (qwen3.5 wrote `.Replace(" ", "-")` until the token limit).
      let looping = false;
      let checkedAt = 0;
      const onToken = (delta: string) => {
        partial += delta;
        if (!longThought && partial.length > THOUGHT_ABORT && !/"action"\s*:|<tool\b/.test(partial)) {
          const t = partialJsonString(partial, "thought") ?? (mode === "native" ? partial : "");
          if (t.length > THOUGHT_ABORT) {
            longThought = true;
            guard.abort();
          }
        }
        if (!looping && partial.length - checkedAt > 400) {
          checkedAt = partial.length;
          if (repeatsLine(partial)) {
            looping = true;
            guard.abort();
          }
        }
        const now = Date.now();
        if (now - lastEmit < 100) return;
        lastEmit = now;
        const thought = partialJsonString(partial, "thought") ?? /<thought>([\s\S]*?)(?:<\/thought>|$)/.exec(partial)?.[1] ?? (mode === "native" ? partial : undefined);
        if (thought !== undefined) emit({ type: "streaming", thought, answer: partialJsonString(partial, "text") ?? partialJsonString(partial, "summary") });
      };
      stats.modelCalls++;
      try {
        const res = await provider.chat({
          messages,
          schema,
          tools,
          signal: signal ? AbortSignal.any([signal, guard.signal]) : guard.signal,
          onToken,
          temperature: provider.profile.temperature + attempt * 0.3,
          repeatPenalty: attempt ? 1.1 + attempt * 0.1 : undefined,
        });
        // Native tool calls are normalized to the JSON action form, so parsing and history are mode-independent.
        const call = res.toolCalls?.[0];
        return call ? { ...res, content: JSON.stringify({ thought: res.content.trim(), action: { tool: call.name, args: call.arguments } }) } : res;
      } catch (e) {
        if ((longThought || looping) && !signal?.aborted) return { content: "", degenerate: true, longThought };
        const retryable = e instanceof ProviderError && e.status === undefined && !signal?.aborted;
        if (!retryable) throw e;
        // Still degenerate after retries: not fatal. An empty reply becomes an invalid step with advice.
        if (attempt >= MODEL_RETRIES) return { content: "", degenerate: true };
        stats.invalidCalls++;
        emit({ type: "invalid", error: `${(e as Error).message}; retrying` });
      }
    }
  }

  /**
   * `after-edit:` hooks from rules (formatters etc.): the code runs them, not the model.
   * Returns text for the observation: only failures, and a re-read warning when a file changed.
   */
  private async runAfterEdit(commands: string[], files: string[]): Promise<string> {
    const { host } = this.deps;
    const existing: string[] = [];
    for (const f of files) if (/^[\w.\-/ @+]+$/.test(f) && (await host.stat(f)) === "file") existing.push(f);
    const before = await Promise.all(existing.map((f) => host.readFile(f).catch(() => "")));
    const notes: string[] = [];
    for (const cmd of commands) {
      if (cmd.includes("{files}") && !existing.length) continue;
      const r = await host.runCommand(cmd.replace("{files}", existing.map((f) => `"${f}"`).join(" ")), undefined, { timeoutMs: 120_000 });
      if (r.exitCode !== 0) notes.push(`After-edit hook \`${cmd}\` failed (exit ${r.exitCode}):\n${failureReport(r.output, host.root, 20)}`);
    }
    const after = await Promise.all(existing.map((f) => host.readFile(f).catch(() => "")));
    const reformatted = existing.filter((_, i) => before[i] !== after[i]);
    if (reformatted.length) notes.push(`The after-edit hook reformatted ${reformatted.join(", ")}: read it again before the next edit.`);
    return notes.length ? `\n\n${notes.join("\n")}` : "";
  }

  /**
   * Runs verify commands from rules; returns failure text, or undefined when all pass.
   * Missing C# using directives are added by code first (`onChange` gets those files).
   */
  private async verify(commands: string[], emit: (e: AgentEvent) => void, onChange?: (files: string[]) => void, seen?: Iterable<string>): Promise<string | undefined> {
    const { host } = this.deps;
    for (const cmd of commands) {
      let r = await host.runCommand(cmd, undefined, { timeoutMs: 300_000 }); // first build may restore packages
      let fixed = "";
      if (r.exitCode !== 0) {
        const read = (p: string) => host.readFile(p);
        const fix = await missingUsings(r.output, host.root, read, async () => projectTypes(await listFiles(host), read));
        if (fix.changes.length && (await host.proposeWrites(fix.changes, "add missing using directives")).applied) {
          onChange?.(fix.changes.map((c) => c.path));
          fixed = `${fix.note}\n`;
          r = await host.runCommand(cmd, undefined, { timeoutMs: 300_000 });
        }
      }
      const layout = r.exitCode !== 0 && /\bdotnet\b/.test(cmd) ? nestedProjectProblem(await listFiles(host)) : undefined;
      const body = relativizePaths(r.exitCode === 0 ? r.output : failureReport(r.output, host.root, 80), host.root);
      const where = r.exitCode === 0 ? "" : await errorContext(r.output, host.root, (p) => host.readFile(p));
      const hints = r.exitCode !== 0 && seen && parseTestFailures(r.output, host.root).length ? await lintHints(seen, (p) => host.readFile(p)) : "";
      const output = `${fixed}$ ${cmd}\nexit code ${r.exitCode}\n${body}${where}${hints}${layout ? `\n\nLikely cause: ${layout}` : ""}`;
      emit({ type: "verify", ok: r.exitCode === 0, output });
      if (r.exitCode !== 0) return output;
    }
    return undefined;
  }

  /** Makes a hidden optional tool's group available for this todo; false when it can't be (not configured). */
  private unlockGroup(tool: ToolDef, ctx: ToolContext): boolean {
    if (tool.available && !tool.available(ctx)) return false;
    if (tool.group === "mcp") (ctx.mcpTools ??= new Set()).add(tool.name);
    else if (tool.group === "symbols") ctx.largeFiles = true;
    else if (tool.group) (ctx.needs ??= new Set()).add(tool.group);
    return true;
  }

  /** Read-only sub-run for the explore tool; its tool calls show up as status lines. */
  private async explore(question: string, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<string> {
    const sub = new Agent({
      ...this.deps,
      nested: true,
      reviewPlan: undefined,
      maxStepsPerTodo: 10,
      onEvent: (e) => {
        if (e.type === "tool") emit({ type: "status", text: `Exploring: ${e.result.summary}` });
      },
    });
    const r = await sub.run(question, "ask", signal);
    if (r.status !== "done") throw new Error(r.summary);
    return r.summary;
  }

  /** A separate, short model call that copies the parts of `text` relevant to `question` (long web pages). */
  private async extract(text: string, question: string, stats: RunStats, signal?: AbortSignal): Promise<string> {
    const res = await this.deps.provider.chat({
      messages: [{ role: "user", content: `${EXTRACT_PROMPT(question)}\n\n<page>\n${text}\n</page>` }],
      temperature: 0,
      maxTokens: 1200,
      signal,
    });
    stats.promptTokens += res.promptTokens ?? 0;
    stats.outputTokens += res.outputTokens ?? 0;
    return res.content;
  }

  /** Asks the user for guidance when the model is stuck. Returns false to give up. */
  private async unstick(index: number, todos: string[], history: History, problem: string): Promise<boolean> {
    if (!this.deps.host.interactive) return false;
    const answer = await this.deps.host.askUser(`The agent is stuck on "${todos[index]}" (${problem.split("\n")[0]}). Any guidance? Leave empty to stop.`);
    if (!answer?.trim()) return false;
    history.note(`User guidance: ${answer.trim()}`);
    return true;
  }
}
