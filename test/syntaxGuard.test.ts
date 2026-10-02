import { describe, expect, it } from "vitest";
import { checkEditStructure, checkEditSyntax, cutOffLine, findImbalance, fixCSharpEscapes } from "../src/edit/syntaxGuard";

describe("fixCSharpEscapes", () => {
  it("doubles regex escapes in normal strings, leaving valid escapes, verbatim and raw strings", async () => {
    const src = 'class A {\n  string a = "[\\s-]+\\n";\n  string b = @"[\\s]";\n  string c = """raw\\s""";\n  string d = "tab\\t, quote \\" and \\\\d";\n}\n';
    const r = await fixCSharpEscapes("A.cs", src);
    expect(r.fixed).toBe(1);
    expect(r.text).toContain('string a = "[\\\\s-]+\\n";');
    expect(r.text).toContain('string b = @"[\\s]";');
    expect(r.text).toContain('string c = """raw\\s""";');
    expect(r.text).toContain('string d = "tab\\t, quote \\" and \\\\d";');
    expect((await fixCSharpEscapes("a.js", '"\\s"')).fixed).toBe(0);
  });
});

describe("findImbalance", () => {
  it("accepts balanced code with brackets inside strings and comments", () => {
    const code = 'function f(a) {\n  // } not a brace\n  const s = "{[(";\n  /* ) */ return `x${a}`;\n}\n';
    expect(findImbalance(code)).toBeUndefined();
  });
  it("reports extra and missing closers", () => {
    expect(findImbalance("class A {\n  f() {\n  }\n}\n}\n")?.message).toMatch(/unexpected '}' at line 5/);
    expect(findImbalance("class A {\n  f() {\n}\n")?.message).toMatch(/opened at line 1 is never closed/);
  });
});

describe("checkEditStructure", () => {
  const before = "class A {\n  total() {\n    return 1;\n  }\n}\n";
  it("rejects an edit that breaks a balanced file", () => {
    expect(checkEditStructure("a.js", before, "class A {\n  total() {\n    return 1;\n  }\n  }\n}\n")).toMatch(/NOT changed/);
  });
  it("ignores non-brace languages and already-broken files", () => {
    expect(checkEditStructure("a.py", "def f():\n  pass\n", "def f(:\n")).toBeUndefined();
    expect(checkEditStructure("a.js", "{", "{{")).toBeUndefined();
  });
});

describe("cut-off replies", () => {
  it("explains a reply cut short by an unescaped quote", async () => {
    const before = "namespace Demo;\n\npublic static class T\n{\n}\n";
    const fragment = "    public static string S(string t)\n    {\n        return Regex.Replace(t, @";
    const after = `namespace Demo;\n\npublic static class T\n{\n${fragment}\n}\n`;
    expect(await checkEditSyntax("T.cs", before, after, fragment)).toMatch(/not escaped/);
    expect(cutOffLine('x = "abc')).toBe('x = "abc');
    expect(cutOffLine('x = "abc";\n')).toBeUndefined();
    expect(cutOffLine('s = "a \\" b";')).toBeUndefined();
  });
});
