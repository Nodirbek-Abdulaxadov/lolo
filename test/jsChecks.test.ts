import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { jsRuntimeProblem } from "../src/edit/jsChecks";
import { EditState } from "../src/edit/formats";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { rewriteFile } from "../src/tools/fileTools";
import { exportShapeProblem } from "../src/tools/moduleSystem";
import type { ToolContext } from "../src/tools/types";

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-js-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  const host = new NodeHost(root, { autoApprove: true });
  const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [], seen: new Set(Object.keys(files)) };
  return { ctx, read: (f: string) => readFileSync(path.join(root, f), "utf8") };
}

const FEES = `const { shippingFee } = require("./fees");

function withShipping(orders) {
  return orders.map((o) => {
    const fee = shippingFee(o.weight);
    return { ...o, fee };
  });
}

module.exports = { withShipping };
`;

describe("jsRuntimeProblem", () => {
  it("refuses a name used in its own const declaration", async () => {
    const after = FEES.replace('const { shippingFee } = require("./fees");', 'const fee = require("./fees").shippingFee;').replace("const fee = shippingFee(o.weight);", "const fee = fee(o.weight);");
    const problem = await jsRuntimeProblem("src/ship.js", FEES, after);
    expect(problem).toMatch(/`fee` is used in its own declaration \(line 5: `const fee = fee\(o\.weight\);`\)/);
    expect(problem).toMatch(/ReferenceError/);
  });

  it("allows self-reference inside a nested function, and var", async () => {
    expect(await jsRuntimeProblem("a.js", "", "const walk = (n) => (n ? walk(n - 1) : 0);\nconst api = { get() { return api; } };\nvar ns = ns || {};\nmodule.exports = { walk, api, ns };\n")).toBeUndefined();
  });

  it("refuses a new reference to a name the file doesn't define, listing the parameters in scope", async () => {
    const after = FEES.replace("shippingFee(o.weight)", "shippingFee(order.weight)");
    const problem = await jsRuntimeProblem("src/ship.js", FEES, after);
    expect(problem).toMatch(/`order` is not defined in src\/ship\.js \(line 5: `const fee = shippingFee\(order\.weight\);`\)/);
    expect(problem).toContain("The enclosing function's parameters are: `o`, `orders`.");
    // Shorthand properties are uses too.
    expect(await jsRuntimeProblem("src/ship.js", FEES, FEES.replace("{ ...o, fee }", "{ ...o, fee, weight }"))).toMatch(/`weight` is not defined/);
  });

  it("lets through what may be defined elsewhere or is not new", async () => {
    const ok = [
      FEES.replace("shippingFee(o.weight)", "helperFee(o.weight)"), // a call: may be defined in the next edit
      FEES.replace("const fee = shippingFee(o.weight);", "const fee = typeof rate === 'number' ? rate : 0;"), // typeof
      FEES.replace("return { ...o, fee };", "console.log(JSON.stringify(o), process.env.X, setTimeout, fetch);\n    return { ...o, fee };"), // globals
      FEES.replace("shippingFee(o.weight)", "shippingFee(o.weight, Rate)"), // capitalized: may be a global class
    ];
    for (const after of ok) expect(await jsRuntimeProblem("src/ship.js", FEES, after)).toBeUndefined();
    // A name the file already used without defining it is a global of its environment.
    const before = FEES.replace("const fee = shippingFee(o.weight);", "const fee = shippingFee(o.weight) * tariff;");
    expect(await jsRuntimeProblem("src/ship.js", before, before.replace("return { ...o, fee };", "return { ...o, fee, tariff };"))).toBeUndefined();
    // ... while a name only in a comment is not defined by that.
    const commented = FEES.replace("function withShipping", "// order: one shipment\nfunction withShipping");
    expect(await jsRuntimeProblem("src/ship.js", commented, commented.replace("shippingFee(o.weight)", "shippingFee(order.weight)"))).toMatch(/`order` is not defined/);
    // Scripts (no require/exports/import) may use globals of other scripts.
    expect(await jsRuntimeProblem("public/app.js", "", "function show() {\n  render(state.items);\n}\n")).toBeUndefined();
    // TypeScript is left to tsc.
    expect(await jsRuntimeProblem("src/a.ts", "", "export const x = y + 1;\n")).toBeUndefined();
  });

  it("refuses a second let/const of the same name in one block, or over a parameter", async () => {
    const test = 'const test = require("node:test");\nconst lib = require("../lib");\n\ntest("stock", () => {\n  const s = lib.create();\n  s.add(1);\n});\n';
    const again = test.replace("  s.add(1);", "  const s = lib.create();\n  s.add(1);");
    expect(await jsRuntimeProblem("test/lib.test.js", test, again)).toMatch(/`s` is declared a second time in the same block \(line 6: `const s = lib.create\(\);`; line 5 already declares it/);
    // A second import of a name points at the first one instead of suggesting a rename.
    const shop = 'const { formatPrice } = require("./cart");\n\nfunction label(p) {\n  return formatPrice(p);\n}\nmodule.exports = { label };\n';
    const twice = await jsRuntimeProblem("src/shop.js", shop, 'const { formatPrice } = require("./format");\n' + shop);
    expect(twice).toMatch(/`formatPrice` is already imported at line 2: `const \{ formatPrice \} = require\("\.\/cart"\);`.*change line 2/);
    expect(twice).not.toMatch(/another name/);
    expect(await jsRuntimeProblem("src/a.js", "", "function f(x) {\n  let x = 1;\n  return x;\n}\nmodule.exports = { f };\n")).toMatch(/`x` is declared a second time/);
    // A function in a default value binds its own parameters.
    expect(await jsRuntimeProblem("src/a.js", "", "function fade(p) {\n  const { duration = (d) => d * 30 } = p;\n  const d = 2;\n  return duration(d);\n}\nmodule.exports = { fade };\n")).toBeUndefined();
    // Shadowing in an inner block, or in a nested function, is fine.
    expect(await jsRuntimeProblem("src/a.js", "", "const x = 1;\nfunction f(y) {\n  const x = y;\n  if (y) {\n    let y2 = 2;\n    const x = y2;\n  }\n  return x;\n}\nmodule.exports = { f, x };\n")).toBeUndefined();
  });

  it("catches a new test file that uses assert without requiring it", async () => {
    const test = 'const test = require("node:test");\nconst { withShipping } = require("../src/ship");\n\ntest("adds fees", () => {\n  assert.strictEqual(withShipping([]).length, 0);\n});\n';
    expect(await jsRuntimeProblem("test/ship.test.js", undefined, test)).toMatch(/`assert` is not defined/);
  });

  it("is refused through the write tools, unless the model writes the same content again", async () => {
    const { ctx, read } = workspace({ "src/ship.js": FEES, "src/fees.js": "function shippingFee(w) {\n  return w * 2;\n}\nmodule.exports = { shippingFee };\n" });
    const broken = FEES.replace("shippingFee(o.weight)", "shippingFee(order.weight)");
    const first = await rewriteFile.run({ path: "src/ship.js", content: broken }, ctx);
    expect(first.ok).toBe(false);
    expect(first.output).toContain("The file was NOT changed.");
    expect(read("src/ship.js")).toBe(FEES);
    expect((await rewriteFile.run({ path: "src/ship.js", content: broken }, ctx)).ok).toBe(true);
  });
});

describe("exportShapeProblem", () => {
  const cart = "class Basket {\n  constructor() {\n    this.items = [];\n  }\n}\n\nmodule.exports = { Basket };\n";
  const files = {
    "lib/basket.js": cart,
    "spec/basket.spec.js": 'const { Basket } = require("../lib/basket");\nnew Basket();\n',
    "lib/other.js": 'const util = require("./util");\n',
  };

  it("refuses an export that changes shape while another file destructures it", async () => {
    const { ctx } = workspace(files);
    const problem = await exportShapeProblem("lib/basket.js", cart, cart.replace("module.exports = { Basket };", "module.exports = Basket;"), ctx);
    expect(problem).toContain('spec/basket.spec.js loads lib/basket.js with `const { Basket } = require("../lib/basket")`');
    expect(problem).toContain("`module.exports = { Basket };`");
  });

  it("allows the same shape, and a shape nobody depends on", async () => {
    const { ctx } = workspace(files);
    expect(await exportShapeProblem("lib/basket.js", cart, cart.replace("{ Basket }", "{ Basket, VERSION: 2 }"), ctx)).toBeUndefined();
    const { ctx: alone } = workspace({ "lib/basket.js": cart });
    expect(await exportShapeProblem("lib/basket.js", cart, cart.replace("module.exports = { Basket };", "module.exports = Basket;"), alone)).toBeUndefined();
  });
});
