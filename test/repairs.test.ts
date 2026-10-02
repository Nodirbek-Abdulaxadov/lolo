import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { laterTodoFor } from "../src/agent/loop";
import { dropLookOnlyTodos, dropUnaskedTestTodos, mergeTodos, namedFiles, stripTodoCode } from "../src/agent/planner";
import { isTestFile, protectTests } from "../src/agent/testGuard";
import { restoreCopiedEscapes } from "../src/edit/escapes";
import { EditState, widenForReassignment } from "../src/edit/formats";
import { fuzzyApply } from "../src/edit/fuzzyApply";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { createFile, doubleEscaped, editFile, editLines, rewriteFile } from "../src/tools/fileTools";
import { addUsing, missingUsings, placeholderNamespaceFix, projectTypes, workspacePath } from "../src/tools/missingImports";
import { toCommonJs, undefinedExports } from "../src/tools/moduleSystem";
import { relativizePaths } from "../src/tools/output";
import { errorContext } from "../src/tools/testReport";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

const STOCK = `function sell(inv, sku, qty) {
  const key = sku.trim();
  inv.stock.set(key, inv.stock.get(key) - qty);
}

function restock(inv, sku, qty) {
  const key = sku.trim();
  inv.stock.set(key, inv.stock.get(key) - qty);
}
`;

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-rep-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  const ctx: ToolContext = { host: new NodeHost(root, { autoApprove: true }), profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [] };
  return { root, ctx, read: (f: string) => readFileSync(path.join(root, f), "utf8") };
}

describe("edit_lines one line short, and a replace escaped twice", () => {
  const shop = "class Order:\n    def __init__(self, sku, qty, notes=[]):\n        self.sku = sku\n        self.qty = qty\n        self.notes = notes\n\n    def note(self, text):\n        self.notes.append(text)\n";

  it("replaces the old assignment the new content redoes, and leaves real second steps", async () => {
    const { ctx, read } = workspace({ "shop.py": shop });
    ctx.edits.forceLineRange("shop.py");
    const content = "    def __init__(self, sku, qty, notes=None):\n        self.sku = sku\n        self.qty = qty\n        self.notes = notes if notes is not None else []\n";
    const r = await editLines.run({ path: "shop.py", start_line: 2, end_line: 4, content }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("lines 2-5 were replaced");
    expect(read("shop.py")).toBe(shop.replace("notes=[]", "notes=None").replace("self.notes = notes\n", "self.notes = notes if notes is not None else []\n"));
    expect(widenForReassignment("x = 1\nx = x + 1\n", 1, 1, "x = 2")).toEqual({ start: 1, end: 1 });
    expect(widenForReassignment("a = 1\nb = 2\n", 1, 1, "a = 3")).toEqual({ start: 1, end: 1 });
  });

  it("replaces the whole block when an edit_lines range is only its first line", async () => {
    const lib = "function fee(total) {\n  // Round to cents.\n  return Math.round(total * 3) / 10;\n}\n\nmodule.exports = { fee };\n";
    const { ctx, read } = workspace({ "lib/fee.js": lib });
    ctx.edits.forceLineRange("lib/fee.js");
    const content = "function fee(total) {\n  // Round to cents.\n  return Math.round(total * 3) / 100;\n}";
    const r = await editLines.run({ path: "lib/fee.js", start_line: 1, end_line: 1, content }, ctx);
    expect(r.ok).toBe(true);
    expect(read("lib/fee.js")).toBe(lib.replace("/ 10;", "/ 100;"));
  });

  it("unescapes a multi-line `replace` written with \\\\n when `search` is one line", async () => {
    const { ctx, read } = workspace({ "shop.py": shop });
    ctx.seen = new Set(["shop.py"]);
    const replace = "def __init__(self, sku, qty, notes=None):\\n        self.sku = sku\\n        self.qty = qty\\n        self.notes = notes if notes is not None else []";
    const r = await editFile.run({ path: "shop.py", search: "    def __init__(self, sku, qty, notes=[]):\n        self.sku = sku\n        self.qty = qty\n        self.notes = notes".split("\n")[0].trim(), replace }, ctx);
    expect(r.ok).toBe(true);
    // The re-typed body replaced the old one instead of staying above it.
    expect(read("shop.py")).toBe(shop.replace("notes=[]", "notes=None").replace("self.notes = notes\n", "self.notes = notes if notes is not None else []\n"));
    expect(r.output).toContain("the old ones were replaced");
  });
});

describe("undoing an uncommitted change the user asked to keep", () => {
  const committed = "function fee(total) {\n  return total * 0.03;\n}\n\nmodule.exports = { fee };\n";
  const changed = "function fee(total) {\n  // Round to cents.\n  return Math.round(total * 3) / 10;\n}\n\nmodule.exports = { fee };\n";

  function repo(message: string) {
    const w = workspace({ "lib/fee.js": committed });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: w.root, stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "start");
    writeFileSync(path.join(w.root, "lib/fee.js"), changed);
    w.ctx.message = message;
    return w;
  }

  it("refuses to restore the committed file, unless the model insists", async () => {
    const { ctx, read } = repo("My change to lib/fee.js broke the tests. Fix it but keep the rounding to cents I added.");
    const first = await rewriteFile.run({ path: "lib/fee.js", content: committed }, ctx);
    expect(first.ok).toBe(false);
    expect(first.output).toContain('they asked to keep part of it ("…');
    expect(read("lib/fee.js")).toBe(changed);
    expect((await rewriteFile.run({ path: "lib/fee.js", content: committed }, ctx)).ok).toBe(true);
  });

  it("allows it when nothing is to be kept, and allows real fixes", async () => {
    expect((await rewriteFile.run({ path: "lib/fee.js", content: committed }, repo("My change to lib/fee.js broke the tests, undo it.").ctx)).ok).toBe(true);
    const fixed = changed.replace("Math.round(total * 3) / 10", "Math.round(total * 3) / 100");
    expect((await rewriteFile.run({ path: "lib/fee.js", content: fixed }, repo("Fix it but keep the rounding to cents.").ctx)).ok).toBe(true);
  });
});

describe("search that is only the first line of a block", () => {
  const spec = 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { Queue } = require("../lib/queue");\n\ntest("fifo", () => {\n  const q = new Queue();\n  q.push(1);\n  assert.strictEqual(q.pop(), 1);\n});\n';

  it("replaces the whole old block when `replace` holds it plus a new one", async () => {
    const { ctx, read } = workspace({ "spec/queue.test.js": spec });
    const replace = 'test("fifo", () => {\n  const q = new Queue();\n  q.push(1);\n  assert.strictEqual(q.pop(), 1);\n});\n\ntest("empty", () => {\n  assert.strictEqual(new Queue().pop(), undefined);\n});';
    const r = await editFile.run({ path: "spec/queue.test.js", search: 'test("fifo", () => {', replace }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("replaced the whole old block");
    expect(read("spec/queue.test.js")).toBe(spec.replace(/\n$/, "") + '\n\ntest("empty", () => {\n  assert.strictEqual(new Queue().pop(), undefined);\n});\n');
  });

  it("replaces a whole function whose first line comes after other lines of `search`", async () => {
    const lib = "let seq = 1;\n\nfunction makeOrder(item) {\n  if (!item) throw new Error(\"no item\");\n  return { id: seq++, item };\n}\n\nmodule.exports = { makeOrder };\n";
    const { ctx, read } = workspace({ "lib/orders.js": lib, "lib/check.js": "exports.valid = (x) => !!x;\n" });
    const replace = 'const check = require("./check");\n\nlet seq = 1;\n\nfunction makeOrder(item) {\n  if (!check.valid(item)) throw new Error("no item");\n  return { id: seq++, item };\n}\n\nmodule.exports = { makeOrder };';
    const r = await editFile.run({ path: "lib/orders.js", search: "let seq = 1;\n\nfunction makeOrder(item) {", replace }, ctx);
    expect(r.ok).toBe(true);
    expect(read("lib/orders.js")).toBe(replace + "\n");
  });
});

describe("ambiguous search", () => {
  const search = "  inv.stock.set(key, inv.stock.get(key) - qty);";

  it("reports every match, and applies the one picked with `at`", () => {
    const r = fuzzyApply(STOCK, search, search.replace("-", "+"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.matches).toEqual([3, 8]);
    const picked = fuzzyApply(STOCK, search, search.replace("-", "+"), { at: 8 });
    expect(picked.ok && picked.content.split("\n")[7]).toContain("+ qty");
    expect(picked.ok && picked.content.split("\n")[2]).toContain("- qty");
  });

  it("edits the match inside the function the todo names", async () => {
    const { ctx, read } = workspace({ "src/inv.js": STOCK });
    ctx.todo = "Make restock() in src/inv.js raise the stock";
    const r = await editFile.run({ path: "src/inv.js", search, replace: search.replace("-", "+") }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("changed the one in restock at line 8");
    expect(read("src/inv.js").split("\n")[7]).toContain("+ qty");
    expect(read("src/inv.js").split("\n")[2]).toContain("- qty");
  });

  it("limits all=true to the function the todo is about", async () => {
    const { ctx, read } = workspace({ "src/inv.js": STOCK });
    ctx.todo = "Edit the restock function in src/inv.js to raise the stock";
    const r = await editFile.run({ path: "src/inv.js", search: search.trim(), replace: search.trim().replace("-", "+"), all: true }, ctx);
    expect(r.output).toContain("only in restock");
    expect(read("src/inv.js").split("\n")[2]).toContain("- qty");
    expect(read("src/inv.js").split("\n")[7]).toContain("+ qty");
    // A rename-style all=true that the todo doesn't tie to one function changes everything.
    const { ctx: c2, read: r2 } = workspace({ "src/inv.js": STOCK });
    c2.todo = "Rename the variable key to id";
    await editFile.run({ path: "src/inv.js", search: "key", replace: "id", all: true }, c2);
    expect(r2("src/inv.js")).not.toContain("key");
  });

  it("refuses an append edit that is already in place (degenerate repeats)", () => {
    const file = "class A {\n  toString() { return 'a'; }\n}\n";
    const edit = ["  toString() { return 'a'; }", "  toString() { return 'a'; }\n\n  equals(o) { return o instanceof A; }"] as const;
    const once = fuzzyApply(file, ...edit);
    expect(once.ok).toBe(true);
    const twice = fuzzyApply(once.ok ? once.content : "", ...edit);
    expect(!twice.ok && twice.reason).toMatch(/already applied/);
  });

  it("otherwise lists the places with their functions", async () => {
    const { ctx } = workspace({ "src/inv.js": STOCK });
    ctx.todo = "Fix the stock update";
    const r = await editFile.run({ path: "src/inv.js", search, replace: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("matches 2 places: line 3 (in sell), line 8 (in restock)");
  });
});

describe("replace that repeats the lines around search", () => {
  it("replaces the repeated closing lines instead of duplicating them (C#)", async () => {
    const { ctx, read } = workspace({ "SystemClock.cs": "namespace Greetings;\n\npublic class SystemClock\n{\n    public DateTime Now => DateTime.Now;\n}\n" });
    const r = await editFile.run(
      { path: "SystemClock.cs", search: "public class SystemClock\n{", replace: "public class SystemClock : IClock\n{\n    public DateTime Now => DateTime.Now;\n}" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/replaced, not duplicated|replaced the whole old one/);
    expect(read("SystemClock.cs")).toBe("namespace Greetings;\n\npublic class SystemClock : IClock\n{\n    public DateTime Now => DateTime.Now;\n}\n");
  });

  it("handles a replace that starts with the line before search (JS)", async () => {
    const { ctx, read } = workspace({ "a.js": "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n" });
    const r = await editFile.run({ path: "a.js", search: "  return a - b;\n}", replace: "function add(a, b) {\n  return a + b;\n}" }, ctx);
    expect(r.ok).toBe(true);
    expect(read("a.js")).toBe("function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
  });

  it("replaces the whole function when `replace` is a new version of the one `search` starts", async () => {
    const eu = "const { formatPrice } = require(\"./format\");\n\nfunction euPriceTag(product) {\n  return `${product.name} ${formatPrice(product.cents)}`;\n}\n\nmodule.exports = { euPriceTag };\n";
    const { ctx, read } = workspace({ "src/eu.js": eu });
    const r = await editFile.run(
      { path: "src/eu.js", search: "function euPriceTag(product)", replace: "function euPriceTag(product) {\n  return `${product.name} ${formatPrice(product.cents, \"EUR\")}`;\n}" },
      ctx,
    );
    expect(r.output).toContain("replaced the whole old one");
    expect(read("src/eu.js")).toBe(eu.replace("formatPrice(product.cents)", 'formatPrice(product.cents, "EUR")'));
    // An insertion at the top of a body (unbalanced replace) is left as it is.
    const { ctx: c2, read: r2 } = workspace({ "a.js": "function f(x) {\n  return x;\n}\n" });
    await editFile.run({ path: "a.js", search: "function f(x) {", replace: "function f(x) {\n  if (!x) return 0;" }, c2);
    expect(r2("a.js")).toBe("function f(x) {\n  if (!x) return 0;\n  return x;\n}\n");
  });

  it("doesn't treat a new function inserted above as a redefinition (short names)", async () => {
    const { ctx, read } = workspace({ "a.js": "function f(x) {\n  return x;\n}\n" });
    await editFile.run({ path: "a.js", search: "function f(x) {", replace: "function g() {\n  return 1;\n}\n\nfunction f(x) {" }, ctx);
    expect(read("a.js")).toBe("function g() {\n  return 1;\n}\n\nfunction f(x) {\n  return x;\n}\n");
  });

  it("accepts a one-line complete redefinition too", async () => {
    const { ctx, read } = workspace({ "SystemClock.cs": "namespace Greetings;\n\npublic class SystemClock\n{\n    public DateTime Now => DateTime.Now;\n}\n" });
    const r = await editFile.run({ path: "SystemClock.cs", search: "public class SystemClock", replace: "public class SystemClock : IClock { public DateTime Now => DateTime.Now; }" }, ctx);
    expect(r.ok).toBe(true);
    expect(read("SystemClock.cs")).toBe("namespace Greetings;\n\npublic class SystemClock : IClock { public DateTime Now => DateTime.Now; }\n");
  });

  it("leaves valid edits alone, even when they add a similar line", async () => {
    const { ctx, read } = workspace({ "b.js": "function f() {\n  a();\n}\n" });
    await editFile.run({ path: "b.js", search: "  a();", replace: "  a();\n  a();" }, ctx);
    expect(read("b.js")).toBe("function f() {\n  a();\n  a();\n}\n");
  });
});

describe("line breaks escaped twice", () => {
  it("unescapes search/replace when only the unescaped search is in the file", async () => {
    const { ctx, read } = workspace({ "src/stack.js": "class S {\n  pop() {\n    return this.items.shift();\n  }\n}\n" });
    const r = await editFile.run({ path: "src/stack.js", search: "  pop() {\\n    return this.items.shift();\\n  }", replace: "  pop() {\\n    return this.items.pop();\\n  }" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("escaped twice");
    expect(read("src/stack.js")).toBe("class S {\n  pop() {\n    return this.items.pop();\n  }\n}\n");
  });

  it("fixes new content, but not a one-line \"\\n\" inside a string", async () => {
    expect(doubleEscaped("function f() {\\n  return 1;\\n}")).toBe(true);
    expect(doubleEscaped('return lines.join("\\n");')).toBe(false);
    expect(doubleEscaped("a\nb\\n  c\\n  d")).toBe(false); // has real line breaks
    const { ctx, read } = workspace({});
    const args = { path: "a.js", content: "function f() {\\n  return 1;\\n}\\n" };
    expect(await createFile.check!(args, ctx)).toBeUndefined();
    await createFile.run(args, ctx);
    expect(read("a.js")).toBe("function f() {\n  return 1;\n}\n");
  });
});

describe("checks deferred to a later todo", () => {
  const build = "Program.cs(3,31): error CS1503: Argument 1: cannot convert from 'Greetings.SystemClock' to 'Greetings.IClock' [Clock.csproj]";
  it("defers when the errors name what a later todo changes", () => {
    expect(laterTodoFor(build, ["Edit SystemClock.cs so SystemClock implements IClock"])).toBe("Edit SystemClock.cs so SystemClock implements IClock");
    expect(laterTodoFor("ReferenceError: computeTax is not defined\n    at orderTotal (src/order.js:4:15)", ["Use computeTax in src/invoice.js"])).toBeDefined();
  });
  it("does not defer for unrelated errors or on the last todo", () => {
    expect(laterTodoFor(build, ["Add a README section"])).toBeUndefined();
    expect(laterTodoFor(build, [])).toBeUndefined();
    expect(laterTodoFor("AssertionError: Expected values to be strictly equal", ["Handle the AssertionError case"])).toBeUndefined();
  });
});

describe("syntax repairs", () => {
  it("turns `namespace X;` followed by braces into a block-scoped namespace (C#)", async () => {
    const before = "using Shop.Models;\n\nnamespace Shop.Services;\n\npublic class OrderService\n{\n    public decimal Total(Order o) => o.Lines.Sum(l => l.Price);\n}\n";
    const { ctx, read } = workspace({ "Services/OrderService.cs": before });
    const content =
      "using Shop.Models;\n\nnamespace Shop.Services;\n{\n    public class OrderService\n    {\n        public decimal Total(Order o) => o.Lines == null ? 0 : o.Lines.Sum(l => l.Price);\n    }\n}";
    const r = await rewriteFile.run({ path: "Services/OrderService.cs", content }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("namespace X { ... }");
    expect(read("Services/OrderService.cs")).toContain("namespace Shop.Services\n{");
  });
});

describe("placeholders in new code", () => {
  it("refuses stubs like `// existing implementation` in created files and edits", async () => {
    const { ctx } = workspace({ "src/users.js": "function a() {\n  return 1;\n}\n// existing implementation note\n" });
    const stub = "module.exports = {\n  validateEmail(email) {\n    // existing implementation\n  },\n};\n";
    expect(await createFile.check!({ path: "src/validators.js", content: stub }, ctx)).toMatch(/placeholder/);
    expect(await createFile.check!({ path: "src/ok.js", content: "module.exports = { a: 1 };\n" }, ctx)).toBeUndefined();
    expect(await editFile.check!({ path: "src/users.js", search: "  return 1;", replace: "  // ... rest of the code ...\n  return 2;" }, ctx)).toMatch(/placeholder/);
    // A comment that is already in the file is not a new hole.
    expect(await editFile.check!({ path: "src/users.js", search: "  return 1;", replace: "  return 1; // existing implementation note" }, ctx)).toBeUndefined();
  });

  it("refuses left-out bodies, unless the todo asks for stubs", async () => {
    const { ctx } = workspace({ "src/users.js": "function a() {\n  return 1;\n}\n" });
    const elided = "export function validateEmail(email) { ... }\nexport function validatePhone(phone) { ... }\n";
    const comment = "module.exports = {\n  validateEmail: function(email) {\n    // Email validation logic here\n  },\n};\n";
    expect(await createFile.check!({ path: "src/validators.js", content: elided }, ctx)).toMatch(/placeholder.*read the file the code comes from/);
    expect(await createFile.check!({ path: "src/validators.js", content: comment }, ctx)).toMatch(/Email validation logic here/);
    expect(await createFile.check!({ path: "src/tax.py", content: "def tax(x):\n    # TODO: implement\n    pass\n" }, ctx)).toMatch(/placeholder/);
    // A section comment above real code is not a body left out.
    const real = "// Validation logic here\nfunction validateEmail(email) {\n  return email.includes(\"@\");\n}\n";
    expect(await createFile.check!({ path: "src/validators.js", content: real }, ctx)).toBeUndefined();
    expect(await createFile.check!({ path: "src/validators.js", content: elided }, { ...ctx, todo: "Create src/validators.js with stub functions" })).toBeUndefined();
    // In a rewrite of an existing file too; "existing code" placeholders are still merged, not refused.
    expect(await rewriteFile.check!({ path: "src/users.js", content: "function a() {\n  // implementation goes here\n}\n" }, ctx)).toMatch(/placeholder/);
    expect(await rewriteFile.check!({ path: "src/users.js", content: "function a() {\n  // ... existing code here\n}\nfunction b() {}\n" }, ctx)).toBeUndefined();
  });

  it("creates a missing file written with rewrite_file or edit_lines at line 1", async () => {
    const { ctx, read } = workspace({ "src/users.js": "function a() {\n  return 1;\n}\n", "lib/util.js": "module.exports = {};\n" });
    const content = "function validateEmail(email) {\n  return email.includes(\"@\");\n}\n";
    expect(await rewriteFile.check!({ path: "src/validators.js", content }, ctx)).toBeUndefined();
    expect((await rewriteFile.run({ path: "src/validators.js", content }, ctx)).ok).toBe(true);
    expect(read("src/validators.js")).toBe(content);
    const lines = { path: "src/phone.js", start_line: 1, end_line: 0, content: "module.exports = { ok: true };\n" };
    expect(await editLines.check!(lines, ctx)).toBeUndefined();
    expect((await editLines.run(lines, ctx)).ok).toBe(true);
    expect(read("src/phone.js")).toContain("ok: true");
    // A file with that name elsewhere: the plan guessed the folder, so no second copy.
    expect(await rewriteFile.check!({ path: "src/util.js", content: "module.exports = {};\n" }, ctx)).toMatch(/lib\/util\.js does/);
  });
});

describe("module system", () => {
  const cjs = {
    "src/order.js": "const { round } = require(\"./util\");\n\nfunction orderTotal(n) {\n  return round(n * 1.12);\n}\n\nmodule.exports = { orderTotal };\n",
    "src/util.js": "module.exports = { round: (x) => Math.round(x * 100) / 100 };\n",
  };

  it("turns export/import in a CommonJS project into module.exports/require, or refuses it", async () => {
    const { ctx, read } = workspace(cjs);
    const tax = { path: "src/tax.js", content: "import { round } from \"./util.js\";\n\nexport function computeTax(amount) {\n  return round(amount * 0.12);\n}\n" };
    expect(await createFile.check!(tax, ctx)).toBeUndefined();
    const r = await createFile.run(tax, ctx);
    expect(r.output).toContain("CommonJS");
    expect(read("src/tax.js")).toBe("const { round } = require(\"./util.js\");\n\nfunction computeTax(amount) {\n  return round(amount * 0.12);\n}\n\nmodule.exports = { computeTax };\n");
    const util = { path: "src/util.js", content: "export const round = (x) => Math.round(x * 100) / 100;\n" };
    expect(await rewriteFile.check!(util, ctx)).toBeUndefined();
    expect(util.content).toContain("module.exports = { round };");
    // What can't be converted by code is refused, and so are edits of a part of a file.
    expect(await createFile.check!({ path: "src/t.js", content: "export default function () {}\n" }, ctx)).toMatch(/CommonJS.*module\.exports = \{ name \}/);
    expect(await createFile.check!({ path: "src/t.cjs", content: "export * from \"./x\";\n" }, ctx)).toMatch(/\.cjs/);
    expect(await editFile.check!({ path: "src/order.js", search: "module.exports = { orderTotal };", replace: "export { orderTotal };" }, ctx)).toMatch(/CommonJS/);
    const lineCtx: ToolContext = { ...ctx, profile: { ...ctx.profile, editFormat: "line-range" } };
    expect(await editLines.check!({ path: "src/order.js", start_line: 1, end_line: 1, content: "import { round } from './util';" }, lineCtx)).toMatch(/CommonJS/);
    // Converting the project is fine when the todo asks for it.
    const esm = { path: "src/t.js", content: "export const t = 1;\n" };
    expect(await createFile.check!(esm, { ...ctx, todo: "Convert the project to ES modules" })).toBeUndefined();
    expect(esm.content).toBe("export const t = 1;\n");
  });

  it("converts only the plain forms", () => {
    expect(toCommonJs("export const a = 1;\nexport class B {}\nexport async function c() {}\nconst d = 2;\nexport { d as e };\n")).toBe(
      "const a = 1;\nclass B {}\nasync function c() {}\nconst d = 2;\n\nmodule.exports = { a, B, c, e: d };\n",
    );
    expect(toCommonJs("import * as fs from \"node:fs\";\nimport path from \"node:path\";\nfs.x(path);\n")).toBe("const fs = require(\"node:fs\");\nconst path = require(\"node:path\");\nfs.x(path);\n");
    expect(toCommonJs("export default 1;\n")).toBeUndefined();
    expect(toCommonJs("export { a } from \"./a\";\n")).toBeUndefined();
    expect(toCommonJs("const a = 1;\nmodule.exports = { a };\n")).toBeUndefined();
  });

  it("refuses require in an ES module project, and leaves bundled code alone", async () => {
    const esm = workspace({ "package.json": "{\"type\": \"module\"}", "src/a.js": "export const a = 1;\n" });
    expect(await createFile.check!({ path: "src/b.js", content: "const { a } = require(\"./a\");\nmodule.exports = { b: a };\n" }, esm.ctx)).toMatch(/"type": "module"/);
    expect(await createFile.check!({ path: "src/b.js", content: "import { a } from \"./a.js\";\nexport const b = a;\n" }, esm.ctx)).toBeUndefined();
    expect(await createFile.check!({ path: "lib/x.mjs", content: "module.exports = {};\n" }, esm.ctx)).toMatch(/\.mjs/);
    // No "type", but the project's code is import/export (a bundler runs it): export is right.
    const web = workspace({ "package.json": "{\"name\": \"web\"}", "src/app.js": "import { h } from \"./h\";\nexport default h;\n" });
    expect(await createFile.check!({ path: "src/h.js", content: "export function h() {}\n" }, web.ctx)).toBeUndefined();
  });
});

describe("test guard", () => {
  it("protects tests when the message is about failing tests or forbids changing them", () => {
    for (const m of [
      "`npm test` fails. Find out why and fix the code in src/ (don't change the tests).",
      "My uncommitted change to src/rate.js broke the tests. Use git diff to see what I changed.",
      "Cart.total() ignores item quantity. Fix it so the tests pass.",
      "the tests are still failing",
      "python3 -m unittest fails. Fix inventory.py (do not modify the tests)",
    ]) expect(protectTests(m), m).toBe(true);
    for (const m of [
      "Add a method applyDiscount(percent) to Cart. Add a test for it in test/cart.test.js.",
      "Rename the class ShoppingCart to Basket everywhere: its definition, its export and every use in src/ and test/.",
      "Rename the class Invoice to Bill everywhere (the billing package and the tests).",
      "The test for parseDate fails because the test is wrong: update the test to expect UTC.",
      "Implement median(xs) in stats.py.",
    ]) expect(protectTests(m), m).toBe(false);
    expect(["test/a.test.js", "src/a.spec.ts", "test_config.py", "pkg/words_test.go", "Api.Tests/UsersTests.cs", "tests/helpers.js"].every(isTestFile)).toBe(true);
    expect(["src/test-utils-free.js", "src/contest.js", "attest.py"].some(isTestFile)).toBe(false);
  });

  it("refuses edits to existing tests while protected, not new files", async () => {
    const { ctx } = workspace({ "src/a.js": "exports.a = 1;\n", "test/a.test.js": "// test\n" });
    ctx.protectTests = true;
    const reg = new ToolRegistry();
    const edit = await reg.check({ thought: "", tool: "edit", args: { path: "test/a.test.js", search: "// test", replace: "// x" } }, reg.all, ctx);
    expect(!edit.ok && edit.error).toContain("is a test");
    expect((await reg.check({ thought: "", tool: "edit", args: { path: "src/a.js", search: "1", replace: "2" } }, reg.all, ctx)).ok).toBe(true);
    expect((await reg.check({ thought: "", tool: "create_file", args: { path: "test/b.test.js", content: "// new\n" } }, reg.all, ctx)).ok).toBe(true);
  });
});

describe("regex escapes a JSON-constrained model couldn't write", () => {
  const users = String.raw`function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = { validateEmail };
`;

  it("restores copied lines whose \\s came out as a line break or `\\ `", async () => {
    const { ctx, read } = workspace({ "src/users.js": users });
    ctx.seen = new Set(["src/users.js"]);
    const broken = "function validateEmail(email) {\n  return /^[^\n@]+@[^\n@]+\\.[^\n@]+$/.test(email);\n}\n\nmodule.exports = { validateEmail };\n";
    const r = await createFile.run({ path: "src/validators.js", content: broken }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("restored");
    expect(read("src/validators.js")).toBe(users);
    const spaced = "function validateEmail(email) {\n  return /^[^\\ @]+@[^\\ @]+\\.[^\\ @]+$/.test(email);\n}\n\nmodule.exports = { validateEmail };\n";
    expect((await rewriteFile.run({ path: "src/validators.js", content: spaced.replace("module.exports = { validateEmail };", "const MAX_EMAIL = 254;\n\nmodule.exports = { validateEmail, MAX_EMAIL };") }, ctx)).ok).toBe(true);
    expect(read("src/validators.js")).toContain(String.raw`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`);
    // A stray line break before an escape the model did write, or in front of `\+`.
    expect(restoreCopiedEscapes("    return /^[^\n\\s@]+@[^\n\\s@]+\\.[^\n\\s@]+$/.test(email);", users.split("\n")).text).toBe(String.raw`    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);`);
    const phone = String.raw`  return /^\+?[0-9 ]{7,15}$/.test(phone);`;
    expect(restoreCopiedEscapes("    return /^\n\\+?[0-9 ]{7,15}$/.test(phone);\n  }", [phone])).toEqual({ text: String.raw`    return /^\+?[0-9 ]{7,15}$/.test(phone);` + "\n  }", fixed: 1 });
    // The backslash kept and the escaped character lost: `[^\` + line break + `@]`, `/^\` + line break + `?`.
    const kept = "    return /^[^\\\n@]+@[^\\\n@]+\\.[^\\\n@]+$/.test(email);\n  },\n  validatePhone: function(phone) {\n    return /^\\\n?[0-9 ]{7,15}$/.test(phone);";
    expect(restoreCopiedEscapes(kept, [...users.split("\n"), phone])).toEqual({
      text: String.raw`    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);` + "\n  },\n  validatePhone: function(phone) {\n" + String.raw`    return /^\+?[0-9 ]{7,15}$/.test(phone);`,
      fixed: 2,
    });
    // Every escape (`\.` too) as a bare line break, and `\+?` lost with its quantifier.
    const bare = "    return /^[^\n@]+@[^\n@]+\n[^\n@]+$/.test(email);\n    return /^\n[0-9 ]{7,15}$/.test(phone);";
    expect(restoreCopiedEscapes(bare, [...users.split("\n"), phone]).text).toBe(
      String.raw`    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);` + "\n" + String.raw`    return /^\+?[0-9 ]{7,15}$/.test(phone);`,
    );
    // `[+]` and `[.]` written for `\+` and `\.` (the same regex), next to `\d` lost as a line break.
    const amount = String.raw`  if (!/^\+?\d+(\.\d+)?$/.test(amount)) return null;`;
    expect(restoreCopiedEscapes("    if (!/^\n[+]?\n+([.]\n+)?$/.test(amount)) return null;", [amount])).toEqual({ text: "  " + amount, fixed: 1 });
    // Code that is really on several lines stays so.
    expect(restoreCopiedEscapes("foo(\n  bar);", ["foo(bar);"]).fixed).toBe(0);
    // `search` too, against the file being edited.
    const edit = await editFile.run({ path: "src/users.js", search: "  return /^[^\n@]+@[^\n@]+\\.[^\n@]+$/.test(email);", replace: "  return isEmail(email);" }, ctx);
    expect(edit.ok).toBe(true);
    expect(read("src/users.js")).toContain("return isEmail(email);");
  });
});

describe("exports of undefined names", () => {
  it("finds exported names the file doesn't define", () => {
    expect(undefinedExports("src/tax.js", "module.exports = { computeTax };\n")).toEqual(["computeTax"]);
    expect(undefinedExports("src/tax.js", "function computeTax(a) {\n  return a;\n}\nmodule.exports = { computeTax };\n")).toEqual([]);
    expect(undefinedExports("src/a.js", "const { round } = require(\"./util\");\nconst f = (a, b) => a + b;\nmodule.exports = { round, f, g: (x, y) => x, h: helper };\n")).toEqual(["helper"]);
    expect(undefinedExports("src/a.mjs", "import { a } from \"./a.js\";\nexport { a, b as c };\n")).toEqual(["b"]);
    expect(undefinedExports("src/a.py", "module.exports = { x }")).toEqual([]);
  });

  it("finds nothing in the evaluation's repos and reference solutions", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
    const files = walk(path.join(__dirname, "../eval/tasks")).filter((f) => /\.(c|m)?js$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(undefinedExports(f, readFileSync(f, "utf8")), f).toEqual([]);
  });

  it("refuses the write and keeps the file", async () => {
    const { ctx, root } = workspace({ "src/order.js": "module.exports = {};\n" });
    const r = await createFile.run({ path: "src/tax.js", content: "module.exports = { computeTax };\n" }, ctx);
    expect(!r.ok && r.output).toContain("without defining it");
    expect(existsSync(path.join(root, "src/tax.js"))).toBe(false);
  });
});

describe("read before moving code into a new file", () => {
  it("refuses the new file until one of the files the code comes from was read", async () => {
    const { ctx } = workspace({ "src/order.js": "const t = Math.round(n * 0.12 * 100) / 100;\n", "src/invoice.js": "const t = Math.round(a * 0.12 * 100) / 100;\n" });
    ctx.seen = new Set();
    ctx.message = "src/order.js and src/invoice.js both compute a 12% tax inline. Move that into a function computeTax(amount) exported from a new file src/tax.js.";
    const reg = new ToolRegistry();
    const create = { thought: "", tool: "create_file", args: { path: "src/tax.js", content: "function computeTax(a) {\n  return a * 0.12;\n}\nmodule.exports = { computeTax };\n" } };
    const refused = await reg.check(create, reg.all, ctx);
    expect(!refused.ok && refused.policy).toBe(true);
    expect(!refused.ok && refused.error).toContain("read_file src/order.js or src/invoice.js");
    ctx.seen.add("src/invoice.js");
    expect((await reg.check(create, reg.all, ctx)).ok).toBe(true);
    // Not a move: a new file needs no reading first.
    ctx.seen = new Set();
    ctx.message = "Add a function computeTax in a new file src/tax.js and use it in src/order.js.";
    expect((await reg.check(create, reg.all, ctx)).ok).toBe(true);
  });
});

describe("mergeTodos", () => {
  it("merges consecutive todos about the same single file", () => {
    const todos = [
      "Create a new file src/tax.js.",
      "Add the function computeTax(amount) to src/tax.js.",
      "Export the computeTax function from src/tax.js.",
      "Replace the inline tax computation in src/order.js with a call to computeTax(amount).",
      "Replace the inline tax computation in src/invoice.js with a call to computeTax(amount).",
    ];
    expect(mergeTodos(todos)).toEqual([
      "Create a new file src/tax.js; then add the function computeTax(amount) to src/tax.js; then export the computeTax function from src/tax.js.",
      todos[3],
      todos[4],
    ]);
  });

  it("folds code the planner split into todos back into its todo", () => {
    const todos = ["Create a new file IClock.cs with the following content:", "```csharp", "public interface IClock", "{", "DateTime Now { get; }", "}", "```", "Make SystemClock implement IClock"];
    expect(mergeTodos(todos)).toEqual([
      "Create a new file IClock.cs with the following content:\n```csharp\npublic interface IClock\n{\nDateTime Now { get; }\n}\n```",
      "Make SystemClock implement IClock",
    ]);
  });

  it("drops todos that only look, keeping checks the user may have asked for", () => {
    const todos = [
      "Read the changes in src/rate.js using git diff.",
      "Identify the specific change that broke the tests.",
      "Locate the corresponding test in test/rate.test.js.",
      "Fix the change in src/rate.js to keep the rounding to cents.",
      "Run the tests to verify the fix.",
    ];
    expect(dropLookOnlyTodos(todos, "g")).toEqual([todos[3], todos[4]]);
    expect(dropLookOnlyTodos(["Find and fix the null check in src/a.js"], "g")).toEqual(["Find and fix the null check in src/a.js"]);
    expect(dropLookOnlyTodos(["Read src/a.js", "Review src/b.js"], "Explain the code")).toEqual(["Explain the code"]);
    expect(dropLookOnlyTodos(["Check the /health endpoint with curl"], "g")).toEqual(["Check the /health endpoint with curl"]);
  });

  it("keeps a look-only todo as the first part of a todo that points back at it", () => {
    expect(dropLookOnlyTodos(["Open lib/ledger.js.", "Locate the line in applyRefund that computes the balance.", "Change the identified line so refunds add to the balance."], "g")).toEqual([
      "Open lib/ledger.js; then locate the line in applyRefund that computes the balance; then change the identified line so refunds add to the balance.",
    ]);
    expect(dropLookOnlyTodos(["Find where applyRefund updates the balance.", "Fix that calculation.", "Update the changelog."], "g")).toEqual([
      "Find where applyRefund updates the balance; then fix that calculation.",
      "Update the changelog.",
    ]);
  });

  it("strips code the planner wrote into a todo after a colon", () => {
    expect(stripTodoCode("Create a new file lib/fees.js with the content: function fee(total) { return total * 0.03; } module.exports = { fee };")).toBe("Create a new file lib/fees.js");
    expect(stripTodoCode("Edit lib/cart.js to use fee: const { fee } = require('./fees'); function total(items) { return sum(items) + fee(sum(items)); }")).toBe("Edit lib/cart.js to use fee");
    // Plain sentences, backticked names and short snippets stay.
    for (const t of ["Paging.cs: throw for size 0", "Run `dotnet new console -n App`: it creates the project", "Fix lib/a.js: the loop skips the last item", "Add a method: `peek()` returns the top item"]) {
      expect(stripTodoCode(t)).toBe(t);
    }
  });

  it("drops test todos the user didn't ask for", () => {
    const todos = ["Override Equals and GetHashCode in Money.cs", "Test equality logic with unit tests"];
    expect(dropUnaskedTestTodos(todos, "Two Money values with the same Amount must be equal.")).toEqual([todos[0]]);
    expect(dropUnaskedTestTodos(["Add applyDiscount to Cart", "Add a test for it in test/cart.test.js"], "Add applyDiscount. Add a test for it.")).toHaveLength(2);
    expect(dropUnaskedTestTodos(["Add /health", "Check /health with curl"], "Add /health, then check it with curl")).toHaveLength(2);
    expect(dropUnaskedTestTodos(["Verify the build"], "Fix the typo")).toEqual(["Verify the build"]); // never empty
  });

  it("keeps todos about different or several files apart", () => {
    const todos = ["Add applyDiscount(percent) to Cart in src/cart.js", "Add a test for it in test/cart.test.js", "Update src/a.js and src/b.js", "Fix src/a.js"];
    expect(mergeTodos(todos)).toEqual(todos);
    expect(namedFiles("Paging.cs: fix PageCount in Paging.cs")).toEqual(["Paging.cs"]);
    expect(mergeTodos(["Fix PageCount in Paging.cs", "Paging.cs: throw for size 0"])).toEqual(["Fix PageCount in Paging.cs; then Paging.cs: throw for size 0"]);
  });
});

describe("missing using directives", () => {
  it("adds after the last using, or before a file-scoped namespace", () => {
    expect(addUsing("using System;\n\nnamespace Demo;\n", "System.Text")).toBe("using System;\nusing System.Text;\n\nnamespace Demo;\n");
    expect(addUsing("namespace Demo;\r\n\r\nclass A {}\r\n", "System.Text.RegularExpressions")).toBe("using System.Text.RegularExpressions;\r\n\r\nnamespace Demo;\r\n\r\nclass A {}\r\n");
    expect(addUsing("using System.Text;\nclass A {}\n", "System.Text")).toBe("using System.Text;\nclass A {}\n");
  });

  it("reads CS0103/CS0246 errors with absolute Windows or relative paths", async () => {
    const root = "C:\\Users\\me\\AppData\\Local\\Temp\\eval-x";
    const out = [
      "C:\\Users\\me\\AppData\\Local\\Temp\\eval-x\\TextUtils.cs(14,16): error CS0103: The name 'Regex' does not exist in the current context [C:\\Users\\me\\AppData\\Local\\Temp\\eval-x\\Text.csproj]",
      "src/Report.cs(3,9): error CS0246: The type or namespace name 'StringBuilder' could not be found (are you missing a using directive or an assembly reference?)",
      "src/Report.cs(4,9): error CS0246: The type or namespace name 'Newtonsoft' could not be found",
    ].join("\n");
    const files: Record<string, string> = { "TextUtils.cs": "namespace Demo;\n", "src/Report.cs": "namespace Demo;\n" };
    const r = await missingUsings(out, root, async (p) => files[p]);
    expect(r.changes.map((c) => c.path)).toEqual(["TextUtils.cs", "src/Report.cs"]);
    expect(r.changes[0].content).toBe("using System.Text.RegularExpressions;\n\nnamespace Demo;\n");
    expect(r.note).toContain("`using System.Text;` to src/Report.cs");
    expect(workspacePath("D:\\other\\A.cs", root)).toBeUndefined();
  });

  it("adds the using of a type the project declares in another namespace", async () => {
    const files: Record<string, string> = { "Clocks/IClock.cs": "namespace Shop.Clocks;\n\npublic interface IClock { DateTime Now { get; } }\n", "Greeter.cs": "namespace Shop;\n\npublic class Greeter { }\n" };
    const read = async (p: string) => files[p];
    const out = "Greeter.cs(5,22): error CS0246: The type or namespace name 'IClock' could not be found (are you missing a using directive or an assembly reference?)\n";
    const r = await missingUsings(out, "/ws", read, () => projectTypes(Object.keys(files), read));
    expect(r.changes).toEqual([{ path: "Greeter.cs", content: "using Shop.Clocks;\n\nnamespace Shop;\n\npublic class Greeter { }\n" }]);
  });

  it("gives a new file in a placeholder namespace the project's namespace", () => {
    const others = ["namespace Shop;\n\npublic class Greeter { }\n", "namespace Shop;\npublic class A { }\n"];
    expect(placeholderNamespaceFix("namespace YourNamespace { public interface IClock { } }", others)).toEqual({ content: "namespace Shop { public interface IClock { } }", from: "YourNamespace", to: "Shop" });
    expect(placeholderNamespaceFix("namespace Shop.Clocks;\npublic interface IClock { }", others)).toBeUndefined(); // a real sub-namespace
    expect(placeholderNamespaceFix("namespace MyNamespace;", ["namespace A;", "namespace B;"])).toBeUndefined(); // no single project namespace
  });

  it("knows the nullability attributes (NotNullWhen reports its Attribute name too)", async () => {
    const out = "Point.cs(9,34): error CS0246: The type or namespace name 'NotNullWhenAttribute' could not be found\nPoint.cs(9,34): error CS0246: The type or namespace name 'NotNullWhen' could not be found\n";
    const r = await missingUsings(out, "/ws", async () => "namespace Geo;\n");
    expect(r.changes).toEqual([{ path: "Point.cs", content: "using System.Diagnostics.CodeAnalysis;\n\nnamespace Geo;\n" }]);
  });
});

describe("errorContext", () => {
  const greeter = "namespace Greetings;\n\npublic class Greeter\n{\n    private readonly SystemClock _clock;\n\n    public Greeter(IClock clock) => _clock = clock;\n}\n";
  const files: Record<string, string> = { "Greeter.cs": greeter, "src/a.js": "const x = 1;\nfoo();\n", "app.py": "import os\nprint(y)\n" };
  const read = async (p: string) => files[p] ?? Promise.reject(new Error("missing"));

  it("shows the code around compiler errors, marking the line", async () => {
    const root = "C:\\w";
    const out = "C:\\w\\Greeter.cs(7,46): error CS0266: Cannot implicitly convert type 'IClock' to 'SystemClock' [C:\\w\\Clock.csproj]";
    const ctx = await errorContext(out, root, read);
    expect(ctx).toContain("Greeter.cs:");
    expect(ctx).toContain("   5 |     private readonly SystemClock _clock;");
    expect(ctx).toContain("   7 >     public Greeter(IClock clock) => _clock = clock;");
  });

  it("reads node and python locations, and skips files outside the workspace", async () => {
    expect(await errorContext("ReferenceError: foo is not defined\n    at Object.<anonymous> (/w/src/a.js:2:1)\nsrc/a.js:2:1: nope", "/w", read)).toContain("   2 > foo();");
    expect(await errorContext('  File "/w/app.py", line 2, in <module>\nNameError: y', "/w", read)).toContain("   2 > print(y)");
    expect(await errorContext('  File "/usr/lib/python3.12/json/__init__.py", line 9', "/w", read)).toBe("");
  });
});

describe("relativizePaths", () => {
  it("turns absolute workspace paths into relative ones with forward slashes", () => {
    const root = "C:\\Users\\me\\proj";
    expect(relativizePaths("C:\\Users\\me\\proj\\src\\A.cs(3,5): error CS1002 [C:\\Users\\me\\proj\\A.csproj]", root)).toBe("src/A.cs(3,5): error CS1002 [A.csproj]");
    expect(relativizePaths("at /home/u/app/src/a.js:10:3", "/home/u/app")).toBe("at src/a.js:10:3");
    expect(relativizePaths("c:/users/me/proj/x.py line 3", root)).toBe("x.py line 3");
  });
});
