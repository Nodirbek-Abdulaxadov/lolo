import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, repeatsLine } from "../src/agent/loop";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import type { ChatMessage, ChatRequest, LLMProvider } from "../src/providers/types";

/** A model that replies from a script, in order, and records what it was sent. */
class Scripted implements LLMProvider {
  readonly model = "scripted";
  readonly profile = resolveProfile("qwen2.5-coder:7b");
  readonly seen: ChatMessage[][] = [];
  /** The `format` schema of each call: which tools were offered. */
  readonly schemas: unknown[] = [];
  constructor(private readonly replies: (string | object)[]) {}
  async chat(req: ChatRequest) {
    this.seen.push(req.messages);
    this.schemas.push(req.schema);
    const next = this.replies.shift() ?? { thought: "out of script", action: { tool: "done", args: { summary: "end" } } };
    const content = typeof next === "string" ? next : JSON.stringify(next);
    // Streamed in chunks like a real endpoint, so guards on partial output can stop it.
    for (let i = 0; i < content.length; i += 50) {
      if (req.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      req.onToken?.(content.slice(i, i + 50));
    }
    return { content };
  }
  async complete() {
    return "";
  }
}

const act = (tool: string, args: object) => ({ thought: `use ${tool}`, action: { tool, args } });
const plan = (todos: string[]) => ({ goal: "g", kind: "task", reply: "", todos });

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-loop-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  return { root, read: (f: string) => readFileSync(path.join(root, f), "utf8") };
}

const run = (root: string, provider: Scripted, task: string) =>
  new Agent({ host: new NodeHost(root, { autoApprove: true }), provider, commandAllowlist: [], trajectory: false }).run(task, "agent");

describe("agent loop", () => {
  it("stops an identical edit that was already applied instead of repeating it forever", async () => {
    const { root, read } = workspace({ "a.txt": "one\n" });
    const append = act("edit", { path: "a.txt", search: "one", replace: "one\ntwo" });
    const provider = new Scripted([plan(["Add a line two after one in a.txt"]), act("read_file", { path: "a.txt" }), append, append, append, append, append]);
    const r = await run(root, provider, "Add a line two after one in a.txt");
    expect(read("a.txt")).toBe("one\ntwo\n");
    expect(r.status).toBe("failed"); // stuck: nobody to ask in a headless run
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/already made exactly this change/);
  });

  it("offers only the writing tools once when the model is stuck only looking", async () => {
    const { root, read } = workspace({ "src/rate.js": "exports.rate = (a) => a * 100;\n" });
    const look = act("read_file", { path: "src/rate.js" });
    const fix = act("rewrite_file", { path: "src/rate.js", content: "exports.rate = (a) => a / 100;\n" });
    const provider = new Scripted([plan(["Fix the rate in src/rate.js"]), look, act("search", { query: "rate" }), look, look, look, fix, act("done", { summary: "fixed" })]);
    const r = await run(root, provider, "Fix the rate in src/rate.js");
    expect(r.status).toBe("done");
    expect(read("src/rate.js")).toBe("exports.rate = (a) => a / 100;\n");
    const forcedAt = provider.seen.findIndex((m) => /Stop looking: you have read the code/.test(JSON.stringify(m)));
    expect(forcedAt).toBeGreaterThan(0);
    const offered = JSON.stringify(provider.schemas[forcedAt]);
    expect(offered).toContain("rewrite_file");
    expect(offered).not.toContain('"read_file"');
    expect(offered).not.toContain('"done"');
    // After the write applied, everything is offered again.
    expect(JSON.stringify(provider.schemas.at(-1))).toContain('"done"');
  });

  it("treats redoing an applied change as a no-op, not a failed edit", async () => {
    const { root, read } = workspace({ "src/fee.js": "function fee(order) {\n  return order.total * 0.05;\n}\nmodule.exports = { fee };\n" });
    const change = act("edit", { path: "src/fee.js", search: "  return order.total * 0.05;", replace: "  return Math.round(order.total * 5) / 100;" });
    const provider = new Scripted([plan(["Round the fee in src/fee.js to cents", "Use cents for fees in src/fee.js and src/total.js"]), act("read_file", { path: "src/fee.js" }), change, act("done", { summary: "a" }), change, act("done", { summary: "b" })]);
    const r = await run(root, provider, "Round the fee in src/fee.js to cents");
    expect(r.status).toBe("done");
    expect(read("src/fee.js")).toContain("Math.round(order.total * 5) / 100");
    expect(r.stats).toMatchObject({ editCalls: 1, editsApplied: 1, noopEdits: 1 });
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/already contains this change/);
    expect(JSON.stringify(provider.seen.at(-1))).not.toMatch(/line-based editing/);
  });

  it("doesn't let the model add tests the user didn't ask for, but lets it update them", async () => {
    const files = { "src/lib.js": "exports.one = () => 2;\n", "test/lib.test.js": 'const test = require("node:test");\nconst { one } = require("../src/lib");\ntest("one", () => {\n  one();\n});\n' };
    const addTest = act("edit", { path: "test/lib.test.js", search: "  one();\n});", replace: '  one();\n});\ntest("is one", () => {\n  one();\n});' });
    const { root } = workspace(files);
    const provider = new Scripted([plan(["Make one() in src/lib.js return 1"]), act("read_file", { path: "test/lib.test.js" }), addTest, act("done", { summary: "ok" })]);
    const r = await run(root, provider, "one() in src/lib.js must return 1");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/didn't ask for tests/);
    expect(r.stats.refusedCalls).toBe(1);
    // Asked for: allowed.
    const { root: root2, read } = workspace(files);
    const provider2 = new Scripted([plan(["Add a test for one() in test/lib.test.js"]), act("read_file", { path: "test/lib.test.js" }), addTest, act("done", { summary: "ok" })]);
    await run(root2, provider2, "Add a test for one()");
    expect(read("test/lib.test.js")).toContain('test("is one"');
  });

  it("treats a change to comments only as a no-op, unless the task is about comments", async () => {
    const src = "function fee(total) {\n  return total * 0.05;\n}\nmodule.exports = { fee };\n";
    const note = act("edit", { path: "src/fee.js", search: "  return total * 0.05;", replace: "  return total * 0.05; // matches the expected output" });
    const { root, read } = workspace({ "src/fee.js": src });
    const provider = new Scripted([plan(["Fix the fee in src/fee.js"]), act("read_file", { path: "src/fee.js" }), note, act("done", { summary: "ok" })]);
    const r = await run(root, provider, "The fee in src/fee.js is wrong");
    expect(read("src/fee.js")).toBe(src);
    expect(r.stats.noopEdits).toBe(1);
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/only touches comments/);
    const { root: root2, read: read2 } = workspace({ "src/fee.js": src });
    await run(root2, new Scripted([plan(["Comment the fee formula in src/fee.js"]), act("read_file", { path: "src/fee.js" }), note, act("done", { summary: "ok" })]), "Add a comment to the fee formula");
    expect(read2("src/fee.js")).toContain("// matches the expected output");
  });

  it("points at move_file when the model writes the target of a requested move by hand", async () => {
    const { root } = workspace({ "shop/helpers.py": "def total(xs):\n    return sum(xs)\n", "main.py": "from shop.helpers import total\n" });
    const create = act("create_file", { path: "shop/math/totals.py", content: "def total(xs):\n    return sum(xs)\n" });
    const provider = new Scripted([plan(["Create shop/math/totals.py with the code of shop/helpers.py"]), act("read_file", { path: "shop/helpers.py" }), create, act("done", { summary: "ok" })]);
    const r = await run(root, provider, "Move shop/helpers.py to shop/math/totals.py and update every import of it.");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/use move_file with from \\"shop\/helpers.py\\" and to \\"shop\/math\/totals.py\\"/);
    expect(r.stats.refusedCalls).toBe(1);
  });

  it("offers to remember a convention the user states in passing", async () => {
    const { root } = workspace({ "src/a.js": "exports.hi = () => \"hi\";\n" });
    const provider = new Scripted([plan(["Change the greeting in src/a.js to hello"]), act("done", { summary: "ok" })]);
    await run(root, provider, "We always use single quotes. Change the greeting in src/a.js to hello.");
    expect(JSON.stringify(provider.seen[1])).toMatch(/states a lasting convention/);
    expect(JSON.stringify(provider.schemas[1])).toContain('"remember"');
    const plain = new Scripted([plan(["Change the greeting in src/a.js to hello"]), act("done", { summary: "ok" })]);
    await run(workspace({ "src/a.js": "x\n" }).root, plain, "Change the greeting in src/a.js to hello.");
    expect(JSON.stringify(plain.schemas[1])).not.toContain('"remember"');
  });

  it("answers a question from what it read when the steps run out, instead of failing", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = `line ${i}\n`;
    const { root } = workspace(files);
    // Only `answer` is offered for the last two steps (the real model is held to it by the schema).
    const reads = Array.from({ length: 13 }, (_, i) => act("read_file", { path: `f${i}.txt` }));
    const provider = new Scripted([{ goal: "g", kind: "question", reply: "", todos: [] }, ...reads, act("answer", { text: "f7.txt" })]);
    const r = await new Agent({ host: new NodeHost(root, { autoApprove: true }), provider, commandAllowlist: [], trajectory: false }).run("where is line 7?", "agent");
    expect(r.status).not.toBe("failed");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/out of steps/);
  });

  it("completes a todo that ran out of steps when its changes pass the checks", async () => {
    const steps = [act("create_file", { path: "notes.txt", content: "hello\n" }), act("read_file", { path: "notes.txt" }), act("list_dir", {}), act("search", { query: "hello" }), act("search", { query: "bye" })];
    const go = (check: string) => {
      const { root } = workspace({ ".agent/rules.md": "- verify: node check.js\n", "check.js": check });
      const provider = new Scripted([plan(["Write hello into notes.txt"]), ...steps]);
      return new Agent({ host: new NodeHost(root, { autoApprove: true }), provider, commandAllowlist: [], trajectory: false, maxStepsPerTodo: 5 }).run("Write hello into notes.txt", "agent");
    };
    expect((await go("process.exit(0);\n")).status).toBe("done");
    const failing = await go("process.exit(1);\n");
    expect(failing.status).toBe("failed");
    expect(failing.summary).toMatch(/no result after 5 steps/);
  });

  it("reminds the model to act after five reads in a row", async () => {
    const { root } = workspace({ "a.txt": "x\n", "b.txt": "y\n" });
    const reads = [act("read_file", { path: "a.txt" }), act("read_file", { path: "b.txt" }), act("list_dir", {}), act("search", { query: "x" }), act("search", { query: "y" })];
    const provider = new Scripted([plan(["Look around"]), ...reads, act("done", { summary: "ok" })]);
    await run(root, provider, "Look around and change nothing");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/5 reads in a row/);
  });

  it("asks the planner again when it put code lines into the todos", async () => {
    const { root } = workspace({ "a.txt": "x\n" });
    const provider = new Scripted([
      plan(["Create IClock.cs with:", "```csharp", "public interface IClock", "{", "}", "```"]),
      plan(["Create IClock.cs with an interface IClock", "Make SystemClock implement IClock"]),
      act("done", { summary: "a" }),
      act("done", { summary: "b" }),
    ]);
    const r = await run(root, provider, "Add IClock");
    expect(r.todos).toEqual(["Create IClock.cs with an interface IClock", "Make SystemClock implement IClock"]);
    expect(JSON.stringify(provider.seen[1])).toMatch(/contain lines of code/);
  });

  it("keeps existing tests read-only when the task is to make failing tests pass", async () => {
    const { root, read } = workspace({ "src/a.js": "exports.two = () => 3;\n", "test/a.test.js": "// expects 2\n" });
    const provider = new Scripted([
      plan(["Fix src/a.js so the tests pass"]),
      act("read_file", { path: "test/a.test.js" }),
      act("edit", { path: "test/a.test.js", search: "// expects 2", replace: "// expects 3" }),
      act("read_file", { path: "src/a.js" }),
      act("edit", { path: "src/a.js", search: "() => 3", replace: "() => 2" }),
      act("done", { summary: "fixed" }),
    ]);
    const r = await run(root, provider, "The tests fail. Fix the code so the tests pass.");
    expect(read("test/a.test.js")).toBe("// expects 2\n");
    expect(read("src/a.js")).toBe("exports.two = () => 2;\n");
    expect(r.status).toBe("done");
    expect(JSON.stringify(provider.seen[3])).toMatch(/is a test/);
  });

  it("defers mid-plan checks to the todo they are about, and runs them there even without changes", async () => {
    const check = 'const t = require("fs").readFileSync("app.txt", "utf8");\nif (!t.includes("implements")) { console.error("error CS0535: SystemClock does not implement IClock"); process.exit(1); }\n';
    const { root, read } = workspace({ ".agent/rules.md": "- verify: node check.js\n", "check.js": check, "app.txt": "Greeter(SystemClock)\n" });
    const todos = ["Make Greeter take an IClock in app.txt", "Make SystemClock implement IClock"];
    const provider = new Scripted([
      plan(todos),
      act("read_file", { path: "app.txt" }),
      act("edit", { path: "app.txt", search: "Greeter(SystemClock)", replace: "Greeter(IClock)" }),
      act("done", { summary: "Greeter takes IClock" }),
      act("done", { summary: "nothing to do" }), // todo 2 claims done without the change: the pending checks catch it
      act("edit", { path: "app.txt", search: "Greeter(IClock)", replace: "Greeter(IClock)\nSystemClock implements IClock" }),
      act("done", { summary: "SystemClock implements IClock" }),
    ]);
    const r = await run(root, provider, "Extract IClock");
    expect(JSON.stringify(provider.seen[4])).toMatch(/run again after it/);
    expect(JSON.stringify(provider.seen[5])).toMatch(/verification failed/);
    expect(read("app.txt")).toContain("implements");
    expect(r.status).toBe("done");
  });

  it("cuts off a thought that runs on without an action", async () => {
    const { root } = workspace({ "a.txt": "x\n" });
    const rambling = `{"thought":"${"I should think about this more carefully. ".repeat(60)}`;
    const provider = new Scripted([plan(["Look at a.txt"]), rambling, act("done", { summary: "ok" })]);
    const r = await run(root, provider, "Look at a.txt and change nothing");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/thought was far too long/);
    expect(r.status).toBe("done");
  });

  it("completes a later 'fix the imports' todo that move_file already did, and keeps code-updated files unread", async () => {
    const { root, read } = workspace({
      "billing/__init__.py": "",
      "billing/utils.py": "def fmt(c):\n    return c\n",
      "billing/report.py": "from billing.utils import fmt\n\n\ndef line(c):\n    return fmt(c)\n",
    });
    const provider = new Scripted([
      plan(["Move billing/utils.py to billing/money/format.py", "Edit every file that imports from billing/utils.py to import from billing/money/format.py"]),
      act("move_file", { from: "billing/utils.py", to: "billing/money/format.py" }),
      act("rewrite_file", { path: "billing/report.py", content: "from billing.money.format import fmt\n" }), // not seen: refused
      act("done", { summary: "moved" }),
    ]);
    const r = await run(root, provider, "Move billing/utils.py to billing/money/format.py and update every import of it.");
    expect(read("billing/report.py")).toBe("from billing.money.format import fmt\n\n\ndef line(c):\n    return fmt(c)\n");
    expect(JSON.stringify(provider.seen[3])).toMatch(/haven't read billing\/report.py/);
    expect(r.status).toBe("done");
    expect(r.summary).toMatch(/Already done: the imports of billing\/utils.py were updated/);
  });

  it("completes later todos that restate a move move_file already did", async () => {
    const { root, read } = workspace({ "shop/__init__.py": "", "shop/helpers.py": "def total(xs):\n    return sum(xs)\n", "main.py": "from shop.helpers import total\n" });
    const provider = new Scripted([
      plan(["Create the new file shop/math/totals.py", "Move the content of shop/helpers.py to shop/math/totals.py", "Update the imports of shop/helpers.py"]),
      act("move_file", { from: "shop/helpers.py", to: "shop/math/totals.py" }),
      act("done", { summary: "moved" }),
      act("move_file", { from: "shop/math/totals.py", to: "shop/helpers.py" }), // must never run
    ]);
    const r = await run(root, provider, "Move shop/helpers.py to shop/math/totals.py and update every import of it.");
    expect(r.status).toBe("done");
    expect(read("main.py")).toBe("from shop.math.totals import total\n");
    expect(provider.seen).toHaveLength(3); // the planner, then two steps of todo 1
  });

  it("stops a reply that repeats one line over and over", async () => {
    expect(repeatsLine(`{"content":"a\\n${'    .Replace(" ", "-")\\n'.repeat(20)}`)).toBe(true);
    expect(repeatsLine("a\nb\n".repeat(20))).toBe(false);
    expect(repeatsLine("}\n".repeat(30))).toBe(false); // too short to mean anything
    // A block of lines repeated (a comment, a commented-out line, a blank line).
    const block = "    # return the item with the lowest price\\n    # return min(items, key=lambda i: i.price)\\n\\n";
    expect(repeatsLine(`{"search":"def cheapest(items):\\n${block.repeat(7)}`)).toBe(true);
    expect(repeatsLine(`{"search":"def cheapest(items):\\n${block.repeat(3)}`)).toBe(false);
    expect(repeatsLine("case 1:\n  return a;\ncase 2:\n  return b;\n".repeat(3))).toBe(false);
    // The same function shape with new names, over and over.
    const names = ["Gross", "Tax", "Net"].flatMap((k) => ["Items", "Amounts", "Lines", "Rows", "Orders"].map((s) => `${k}From${s}`));
    const shaped = names.map((n) => `function calculate${n}(items) {\\n  return items.reduce((total, item) => total + item.${n.toLowerCase()}, 0);\\n}\\n\\n`).join("");
    expect(repeatsLine(`{"content":"const x = 1;\\n${shaped}`)).toBe(true);
    // A table of similar one-liners, and a handful of similar functions, are normal code.
    expect(repeatsLine(Array.from({ length: 60 }, (_, i) => `  CODE_${i} = ${i},`).join("\n") + "\n")).toBe(false);
    expect(repeatsLine(shaped.split("\\n\\n").slice(0, 6).join("\\n\\n") + "\\n\\n")).toBe(false);
    const { root } = workspace({ "a.js": "let a = 1;\n" });
    const loop = JSON.stringify({ thought: "rewrite", action: { tool: "rewrite_file", args: { path: "a.js", content: `let a = 1${'.replace(" ", "-")\n'.repeat(40)}` } } });
    const provider = new Scripted([plan(["Change a.js"]), act("read_file", { path: "a.js" }), loop, act("done", { summary: "ok" })]);
    await run(root, provider, "Change a.js");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/degenerated into repeating itself/);
  });

  it("refuses to edit a file the model hasn't read in this task", async () => {
    const { root, read } = workspace({ "src/a.js": "exports.a = 1;\n" });
    const edit = act("edit", { path: "src/a.js", search: "exports.a = 1;", replace: "exports.a = 2;" });
    const provider = new Scripted([plan(["Set a to 2 in src/a.js"]), edit, act("read_file", { path: "src/a.js" }), edit, act("done", { summary: "ok" })]);
    const r = await run(root, provider, "Set a to 2 in src/a.js");
    expect(JSON.stringify(provider.seen[2])).toMatch(/haven't read src\/a.js/);
    expect(read("src/a.js")).toBe("exports.a = 2;\n");
    expect(r.status).toBe("done");
  });

  it("brings a requested skill to follow-ups and puts its steps first when the plan leaves it out", async () => {
    const skill = "---\nname: jira-task-tracker\ndescription: Track work in Jira via REST API.\n---\nAsk the user first for small tasks. Create the issue with curl.";
    const { root } = workspace({ ".claude/skills/jira-task-tracker/SKILL.md": skill, "Form.razor": "<p/>\n" });
    const provider = new Scripted([plan(["Ask user if Jira should be opened for this small task", "Fix the field error in Form.razor"]), act("done", { summary: "a" })]);
    const agent = new Agent({ host: new NodeHost(root, { autoApprove: true }), provider, commandAllowlist: [], trajectory: false });
    const conversation = "User: jira skill orqali jira task ochishing kerak edi\nAssistant: Jira ochaymi? (taxminiy: 1 kun)";
    const r = await agent.run("och", "agent", undefined, { conversation });
    const planPrompt = JSON.stringify(provider.seen[0]);
    expect(planPrompt).toContain("Create the issue with curl"); // the skill came from the earlier message
    expect(planPrompt).toContain("that is their confirmation");
    expect(r.todos[0]).toMatch(/^Do what the jira-task-tracker skill says/); // "Ask user ..." was dropped
    expect(r.todos).not.toContain("Ask user if Jira should be opened for this small task");
  });
});
