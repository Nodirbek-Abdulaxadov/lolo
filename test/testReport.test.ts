import { describe, expect, it } from "vitest";
import { errorContext, failureReport, formatTestFailures, lintHints, parseTestFailures } from "../src/tools/testReport";
import { relativizePaths } from "../src/tools/output";

describe("parseTestFailures", () => {
  it("node:test", () => {
    const out = `✖ adds (0.9ms)
✔ ok (0.1ms)
ℹ fail 1

✖ failing tests:

test at a.test.js:3:1
✖ adds (0.910372ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  2 !== 3
  
      at TestContext.<anonymous> (/ws/a.test.js:3:29)
      at Test.runInAsyncScope (node:async_hooks:227:14)
`;
    expect(parseTestFailures(out, "/ws")).toEqual([
      { name: "adds", file: "a.test.js", line: 3, message: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 3" },
    ]);
  });

  it("unittest", () => {
    const out = `======================================================================
ERROR: test_b (test_t.T.test_b)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/ws/test_t.py", line 6, in test_b
    raise ValueError("boom")
ValueError: boom

======================================================================
FAIL: test_a (test_t.T.test_a)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/ws/test_t.py", line 4, in test_a
    self.assertEqual(1, 2)
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 2 tests in 0.001s

FAILED (failures=1, errors=1)`;
    expect(parseTestFailures(out, "/ws")).toEqual([
      { name: "test_b", file: "test_t.py", line: 6, message: "ValueError: boom" },
      { name: "test_a", file: "test_t.py", line: 4, message: "AssertionError: 1 != 2" },
    ]);
  });

  it("vitest", () => {
    const out = ` FAIL  test/cart.test.ts > Cart > applies discount
AssertionError: expected 90 to be 80 // Object.is equality
 ❯ test/cart.test.ts:12:25
     10|   const c = new Cart();
`;
    expect(parseTestFailures(out)).toEqual([
      { name: "Cart > applies discount", file: "test/cart.test.ts", line: 12, message: "AssertionError: expected 90 to be 80 // Object.is equality" },
    ]);
  });

  it("jest", () => {
    const out = `  ● Cart › applies discount

    expect(received).toBe(expected) // Object.is equality

    Expected: 80
    Received: 90

      at Object.<anonymous> (src/cart.test.js:12:25)
`;
    expect(parseTestFailures(out)).toEqual([{ name: "Cart › applies discount", file: "src/cart.test.js", line: 12, message: "expect(received).toBe(expected) // Object.is equality" }]);
  });

  it("pytest", () => {
    const out = `_______________________ test_median_even _______________________

    def test_median_even():
>       assert median([1, 2, 3, 4]) == 2.5
E       assert 2 == 2.5

tests/test_stats.py:8: AssertionError
=========================== short test summary info ============================
FAILED tests/test_stats.py::test_median_even - assert 2 == 2.5
`;
    expect(parseTestFailures(out)).toEqual([{ name: "test_median_even", file: "tests/test_stats.py", line: 8, message: "assert 2 == 2.5" }]);
  });

  it("dotnet test", () => {
    const out = `  Failed Shop.Tests.CartTests.Total [12 ms]
  Error Message:
   Assert.Equal() Failure
  Expected: 80
  Actual:   90
  Stack Trace:
     at Shop.Tests.CartTests.Total() in /ws/tests/CartTests.cs:line 42
`;
    expect(parseTestFailures(out, "/ws")).toEqual([
      { name: "Shop.Tests.CartTests.Total", file: "tests/CartTests.cs", line: 42, message: "Assert.Equal() Failure Expected: 80 Actual: 90" },
    ]);
  });

  it("cargo test", () => {
    const out = `---- tests::adds stdout ----
thread 'tests::adds' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 2
`;
    expect(parseTestFailures(out)).toEqual([{ name: "tests::adds", file: "src/lib.rs", line: 12, message: "assertion `left == right` failed" }]);
  });

  it("node:test TAP (the reporter when stdout is not a terminal)", () => {
    const out = String.raw`TAP version 13
# Subtest: equal fails
not ok 1 - equal fails
  ---
  duration_ms: 0.9043
  type: 'test'
  location: 'C:\\ws\\test\\a.test.js:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    2 !== 3

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 3
  actual: 2
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (C:\ws\test\a.test.js:6:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
  ...
# Subtest: throws
not ok 2 - throws
  ---
  location: 'C:\\ws\\test\\a.test.js:8:1'
  failureType: 'testCodeFailure'
  error: "Cannot read properties of undefined (reading 'deep')"
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'
  stack: |-
    f (C:\ws\src\m.js:1:34)
    TestContext.<anonymous> (C:\ws\test\a.test.js:9:3)
  ...
# Subtest: suite
    # Subtest: inner deep
    not ok 1 - inner deep
      ---
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly deep-equal:
        + actual - expected
      expected:
        0: 1
      name: 'AssertionError'
      stack: |-
        TestContext.<anonymous> (C:\ws\test\a.test.js:13:12)
        node:internal/test_runner/test:1440:71
      ...
    # Subtest: inner ok
    ok 2 - inner ok
      ---
      duration_ms: 0.0701
      ...
    1..2
not ok 3 - suite
  ---
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
# node:internal/modules/cjs/loader:1433
# Error: Cannot find module '../src/missing'
# Require stack:
# - C:\\ws\\test\\b.test.js
#     at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
#     at Object.<anonymous> (C:\\ws\\test\\b.test.js:1:18)
# Subtest: test\\b.test.js
not ok 4 - test\\b.test.js
  ---
  location: 'C:\\ws\\test\\b.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  error: 'test failed'
  ...
1..4`;
    expect(parseTestFailures(out, "c:\\ws")).toEqual([
      { name: "equal fails", file: "test/a.test.js", line: 6, message: "Expected values to be strictly equal: 2 !== 3" },
      { name: "throws", file: "src/m.js", line: 1, message: "TypeError: Cannot read properties of undefined (reading 'deep')" },
      { name: "inner deep", file: "test/a.test.js", line: 13, message: "Expected values to be strictly deep-equal: + actual - expected" },
      { name: "test\\b.test.js", file: "test/b.test.js", line: 1, message: "Error: Cannot find module '../src/missing'" },
    ]);
  });

  it("returns nothing for unrelated output", () => {
    expect(parseTestFailures("error CS1002: ; expected")).toEqual([]);
  });
});

describe("failureReport", () => {
  it("lists failures before a short log", () => {
    const report = failureReport("---- t stdout ----\nthread 't' panicked at src/a.rs:1:1:\nboom\n");
    expect(report).toMatch(/^Failing tests \(1\):\n1\. src\/a\.rs:1 t: boom/);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, message: "x" }));
    expect(formatTestFailures(many)).toContain("... and 2 more");
  });
});

describe("errorContext", () => {
  const files: Record<string, string> = {
    "test/stack.test.js": 'const { Stack } = require("../src/stack");\ntest("lifo", () => {\n  const s = new Stack();\n  s.push(1);\n  s.push(2);\n  assert.strictEqual(s.pop(), 2);\n  assert.strictEqual(s.peek(), 1);\n});\n',
    "src/m.js": "function f(x) { return x.missing.deep; }\nmodule.exports = { f };\n",
  };
  const read = async (p: string) => {
    if (!(p in files)) throw new Error("missing");
    return files[p];
  };

  it("shows the failing assertion of a TAP failure", async () => {
    const out = "TAP version 13\nnot ok 1 - lifo\n  ---\n  error: |-\n    Expected values to be strictly equal:\n    \n    2 !== 1\n  stack: |-\n    TestContext.<anonymous> (/ws/test/stack.test.js:7:10)\n  ...\n";
    const ctx = await errorContext(out, "/ws", read);
    expect(ctx).toContain("Code at the errors:\ntest/stack.test.js:");
    expect(ctx).toContain("   7 >   assert.strictEqual(s.peek(), 1);");
  });

  it("shows the code at a frame of a thrown error", async () => {
    const out = "TypeError: Cannot read properties of undefined\n    at f (/ws/src/m.js:1:26)\n    at Object.<anonymous> (/ws/node_modules/x/index.js:3:1)\n";
    const ctx = await errorContext(out, "/ws", read);
    expect(ctx).toContain("src/m.js:\n   1 > function f(x)");
    expect(ctx).not.toContain("node_modules");
  });
});

describe("lintHints", () => {
  it("points at mutable default arguments in source files, not tests", async () => {
    const files: Record<string, string> = {
      "shop/cart.py": "class Cart:\n    def __init__(self, owner, lines=[], meta: dict = {}):\n        self.lines = lines\n\n    def add(self, x, qty=1):\n        pass\n",
      "tests/test_cart.py": "def helper(xs=[]):\n    return xs\n",
      "shop/ok.py": "def f(xs=None, n=0, name='x'):\n    return xs or []\n",
    };
    const hints = await lintHints(Object.keys(files), async (p) => files[p]);
    expect(hints).toContain("Possible cause (static check):");
    expect(hints).toContain("shop/cart.py:2 `def __init__(self, owner, lines=[], meta: dict = {})`: the default `lines=[]` is created once");
    expect(hints).toContain("the default `meta={}`");
    expect(hints).not.toContain("tests/test_cart.py");
    expect(hints).not.toContain("shop/ok.py");
    expect(await lintHints(["shop/ok.py"], async (p) => files[p])).toBe("");
  });
});

describe("relativizePaths", () => {
  it("handles backslashes doubled in quoted TAP locations", () => {
    expect(relativizePaths("location: 'C:\\\\ws\\\\app\\\\test\\\\a.test.js:5:1'", "c:\\ws\\app")).toBe("location: 'test/a.test.js:5:1'");
    expect(relativizePaths("at f (C:\\ws\\app\\src\\m.js:1:2)", "C:\\ws\\app")).toBe("at f (src/m.js:1:2)");
  });
});
