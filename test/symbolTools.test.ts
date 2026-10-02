import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { toolNeeds } from "../src/agent/needs";
import { EditState } from "../src/edit/formats";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { ALL_TOOLS, ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-sym-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  const host = new NodeHost(root, { autoApprove: true });
  const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [] };
  return { root, ctx, read: (f: string) => readFileSync(path.join(root, f), "utf8") };
}

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

const FILES = {
  "src/total.js": "// calcTotal sums prices\nfunction calcTotal(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\nmodule.exports = { calcTotal };\n",
  "src/cart.js": "const { calcTotal } = require('./total');\nconst label = 'calcTotal';\nexports.sum = (c) => calcTotal(c.items);\n",
  "README.md": "Use calcTotal() to sum.\n",
};

describe("refactor tools", () => {
  it("are offered only for todos about renames and references", () => {
    expect(toolNeeds("Rename calcTotal to computeTotal everywhere").has("refactor")).toBe(true);
    expect(toolNeeds("Where is parseDate used?").has("refactor")).toBe(true);
    expect(toolNeeds("Return null from findUser() when the id is empty").has("refactor")).toBe(false);
    const { ctx } = workspace({});
    const names = () => new ToolRegistry().enabled("agent", ctx).map((t) => t.name);
    expect(names()).not.toContain("rename_symbol");
    ctx.needs = toolNeeds("Rename calcTotal to computeTotal");
    expect(names()).toEqual(expect.arrayContaining(["rename_symbol", "find_references", "find_definition"]));
  });

  it("renames code identifiers across files and in their comments, leaving strings, and reports them", async () => {
    const { ctx, read } = workspace(FILES);
    const args = { symbol: "calcTotal", new_name: "computeTotal" };
    expect(await tool("rename_symbol").check!(args, ctx)).toBeUndefined();
    const r = await tool("rename_symbol").run(args, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed?.sort()).toEqual(["src/cart.js", "src/total.js"]);
    expect(read("src/total.js")).toContain("function computeTotal(items)");
    expect(read("src/total.js")).toContain("// computeTotal sums prices"); // a code-like name in a comment is the symbol
    expect(read("src/total.js")).toContain("module.exports = { computeTotal };");
    expect(read("src/cart.js")).toContain("const { computeTotal } = require");
    expect(read("src/cart.js")).toContain("computeTotal(c.items)");
    expect(read("src/cart.js")).toContain("'calcTotal'"); // string untouched
    expect(r.output).toContain("Comments that named it were updated too (1)");
    expect(r.output).toContain("src/cart.js:2");
    expect(r.output).toContain("README.md:1");
  });

  it("leaves comments alone when the name is a plain word", async () => {
    const { ctx, read } = workspace({ "shop.go": "package shop\n\n// Basket holds the items of one Basket order.\ntype Basket struct{ n int }\n\nfunc New() Basket { return Basket{} }\n" });
    const r = await tool("rename_symbol").run({ symbol: "Basket", new_name: "Cart" }, ctx);
    expect(r.ok).toBe(true);
    expect(read("shop.go")).toContain("// Basket holds the items of one Basket order.\ntype Cart struct");
    expect(read("shop.go")).toContain("func New() Cart { return Cart{} }");
  });

  it("refuses a rename onto a name that is already used", async () => {
    const { ctx } = workspace({ "a.js": "function a() {}\nfunction b() { a(); }\n" });
    const r = await tool("rename_symbol").run({ symbol: "a", new_name: "b" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/already used/);
  });

  it("rejects invalid identifiers", async () => {
    const { ctx } = workspace(FILES);
    expect(await tool("rename_symbol").check!({ symbol: "calcTotal", new_name: "compute-total" }, ctx)).toMatch(/not a valid identifier/);
  });

  it("finds references and the definition", async () => {
    const { ctx } = workspace(FILES);
    const refs = await tool("find_references").run({ symbol: "calcTotal" }, ctx);
    expect(refs.output).toContain("src/cart.js:3: exports.sum");
    expect(refs.output).not.toContain("src/cart.js:2");
    expect(refs.output).toContain("README.md");
    const def = await tool("find_definition").run({ symbol: "calcTotal" }, ctx);
    expect(def.ok).toBe(true);
    expect(def.output).toContain("src/total.js lines 2-4");
    expect(def.output).toContain("items.reduce");
  });
});
