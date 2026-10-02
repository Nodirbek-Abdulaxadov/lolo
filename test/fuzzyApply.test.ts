import { describe, expect, it } from "vitest";
import { fuzzyApply } from "../src/edit/fuzzyApply";

const file = ["class A {", "    foo() {", "        return 1;", "    }", "", "    bar() {", "        return 2;", "    }", "}", ""].join("\n");

describe("fuzzyApply", () => {
  it("applies an exact match", () => {
    const r = fuzzyApply(file, "        return 1;", "        return 42;");
    expect(r.ok && r.strategy).toBe("exact");
    expect(r.ok && r.content).toContain("return 42;");
  });

  it("rejects ambiguous exact matches", () => {
    const r = fuzzyApply(file, "    }", "  }");
    expect(r.ok).toBe(false);
  });

  it("matches ignoring indentation and re-indents the replacement", () => {
    const r = fuzzyApply(file, "foo() {\n    return 1;\n}", "foo() {\n    return 10;\n}");
    expect(r.ok && r.strategy).toBe("whitespace");
    expect(r.ok && r.content).toContain("    foo() {\n        return 10;\n    }");
  });

  it("matches small typos fuzzily", () => {
    const r = fuzzyApply(file, "    bar() {\n        retrun 2;\n    }", "    bar() {\n        return 3;\n    }");
    expect(r.ok && r.strategy).toBe("fuzzy");
    expect(r.ok && r.content).toContain("return 3;");
    expect(r.ok && r.content).not.toContain("return 2;");
  });

  it("returns the closest fragment when nothing matches", () => {
    const r = fuzzyApply(file, "    baz() {\n        return 99;\n    }", "x");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.closest?.text).toMatch(/\d\| /);
  });

  it("preserves CRLF line endings", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    const r = fuzzyApply(crlf, "foo() {\n    return 1;\n}", "foo() {\n    return 5;\n}");
    expect(r.ok && r.content).toContain("return 5;\r\n");
    expect(r.ok && r.content.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("deletes when replace is empty", () => {
    const r = fuzzyApply(file, "    bar() {\n        return 2;\n    }\n", "");
    expect(r.ok && r.content).not.toContain("bar()");
  });
});

describe("fuzzyApply stale edits", () => {
  it("reports an already-applied change instead of fuzzy-matching the edited line", () => {
    const edited = "  total() {\n    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);\n  }\n";
    const r = fuzzyApply(edited, "    return this.items.reduce((sum, i) => sum + i.price, 0);", "    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/already applied/);
    expect(!r.ok && r.alreadyApplied).toBe(true);
  });

  it("doesn't call a short `replace` found elsewhere an applied change", () => {
    const r = fuzzyApply("function a() {\n  return x;\n}\n", "  return y + 1;", "  return x;");
    expect(!r.ok && r.alreadyApplied).toBe(false);
  });
});

describe("fuzzyApply all=true", () => {
  it("replaces every exact occurrence", () => {
    const src = 'const { calcTotal } = require("./pricing");\nreturn calcTotal(x) + calcTotal(y);\n';
    const r = fuzzyApply(src, "calcTotal", "computeTotal", { all: true });
    expect(r.ok && r.content).toBe('const { computeTotal } = require("./pricing");\nreturn computeTotal(x) + computeTotal(y);\n');
  });
  it("suggests all=true on ambiguity", () => {
    const r = fuzzyApply("a\na\n", "a", "b");
    expect(!r.ok && r.reason).toMatch(/all=true/);
  });
});
