import { describe, expect, it } from "vitest";
import { pyRuntimeProblem } from "../src/edit/pyChecks";

const SRC = `import json
from pathlib import Path as P

LIMIT = 3


def load(path, *args: str, strict: bool = False, **kw):
    for i, (k, v) in enumerate(json.loads(P(path).read_text()).items()):
        if i >= LIMIT:
            break
    with open(path) as fh:
        data = [line for line in fh if line]
    try:
        return {k: v for k, v in kw.items()}, data, args, strict
    except ValueError as err:
        raise RuntimeError(str(err))
`;

describe("pyRuntimeProblem", () => {
  it("refuses a new reference to a name the file defines nowhere", async () => {
    const after = SRC.replace("if i >= LIMIT:", "if i >= limit:");
    expect(await pyRuntimeProblem("cfg.py", SRC, after)).toMatch(/`limit` is not defined in cfg\.py \(line 9: `if i >= limit:`\).*NameError/);
  });

  it("knows parameters, imports, loops, with/except targets, comprehensions and builtins", async () => {
    expect(await pyRuntimeProblem("cfg.py", undefined, SRC)).toBeUndefined();
    // Attribute and keyword names are not references.
    expect(await pyRuntimeProblem("cfg.py", SRC, SRC + "\nprint(json.dumps({}, indent=2), P.home())\n")).toBeUndefined();
  });

  it("leaves names the file already used, star imports and other languages alone", async () => {
    const before = SRC + "\nlogger.info('x')\n";
    expect(await pyRuntimeProblem("cfg.py", before, before + "logger.debug('y')\n")).toBeUndefined();
    expect(await pyRuntimeProblem("cfg.py", undefined, "from helpers import *\nprint(anything)\n")).toBeUndefined();
    expect(await pyRuntimeProblem("cfg.js", undefined, "print(nope)\n")).toBeUndefined();
  });
});
