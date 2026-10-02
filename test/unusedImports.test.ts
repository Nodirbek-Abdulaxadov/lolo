import { describe, expect, it } from "vitest";
import { unusedImportNote, unusedNewImports } from "../src/edit/unusedImports";

describe("unused new imports", () => {
  it("notes a Python import the write adds and the file never uses", () => {
    const before = "import math\n\nclass Segment:\n    def __init__(self, a, b):\n        self.a = a\n        self.b = b\n\n    def length(self):\n        return math.dist(self.a, self.b)\n";
    const forgot = before.replace("import math\n", "import math\nfrom functools import total_ordering\n");
    expect(unusedNewImports("shapes.py", before, forgot)).toEqual(["total_ordering"]);
    expect(unusedImportNote("shapes.py", before, forgot)).toMatch(/shapes\.py imports `total_ordering` but doesn't use it anywhere yet/);
    expect(unusedNewImports("shapes.py", before, forgot.replace("class Segment:", "@total_ordering\nclass Segment:"))).toEqual([]);
    // Parenthesized, aliased, dotted; imports the file already had are left alone.
    const many = "import os.path\nfrom typing import (\n    Optional,\n    List as L,\n)\n\ndef f(p: Optional[str]) -> L[str]:\n    return [p]\n";
    expect(unusedNewImports("a.py", "", many)).toEqual(["os"]);
    expect(unusedNewImports("a.py", "import os\n", "import os\nx = 1\n")).toEqual([]);
    // A package's __init__ imports to re-export; star imports bind nothing we can see.
    expect(unusedNewImports("pkg/__init__.py", "", "from .shapes import Segment\n")).toEqual([]);
    expect(unusedNewImports("a.py", "", "from shapes import *\n")).toEqual([]);
  });

  it("notes JavaScript and TypeScript imports the same way", () => {
    expect(unusedNewImports("src/a.js", "", 'const { slugify, titleCase: tc } = require("./text");\nconst fs = require("fs");\n\nmodule.exports = { s: slugify };\n')).toEqual(["tc", "fs"]);
    expect(unusedNewImports("src/a.ts", "", 'import fmt, { parse as p, type Opts } from "./fmt";\nimport * as path from "node:path";\n\nexport const x = (o: Opts) => fmt(path.sep, o);\n')).toEqual(["p"]);
    expect(unusedNewImports("src/a.mjs", "", 'import { a } from "./a.js";\nexport { a };\n')).toEqual([]);
    expect(unusedImportNote("src/a.go", "", 'import "fmt"\n')).toBe("");
  });
});
