// Small models import what they mean to use and then don't use it: `from dataclasses import
// dataclass` with no `@dataclass` on the class, and the tests (which didn't check equality)
// passed. Adding an import first and using it in the next edit is normal, so this is a note
// on the write, not a refusal.

const PY_FILE = /\.pyi?$/i;
const JS_FILE = /\.(c|m)?(j|t)sx?$/i;

/** Names bound by the import statements of `code`, with the text of those statements. */
function imports(path: string, code: string): { names: string[]; statements: string[] } {
  const names: string[] = [];
  const statements: string[] = [];
  const add = (list: string) => {
    for (const part of list.split(",")) {
      const m = /(?:\bas\s+|:\s*)?([A-Za-z_$][\w$]*)\s*$/.exec(part.replace(/[(){}\s]+$/g, "").replace(/^[\s({]+/, ""));
      if (m && m[1] !== "type") names.push(m[1]);
    }
  };
  if (PY_FILE.test(path)) {
    // Top-level imports only: one inside `try:` often only checks that a module is there.
    for (const m of code.matchAll(/^from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
      if (m[2].trim() === "*" || m[1] === "__future__") continue;
      statements.push(m[0]);
      add(m[2]);
    }
    for (const m of code.matchAll(/^import\s+([^\n#]+)/gm)) {
      statements.push(m[0]);
      // `import os.path` binds `os`.
      for (const part of m[1].split(",")) {
        const p = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (p) names.push(p[2] ?? p[1].split(".")[0]);
      }
    }
  } else if (JS_FILE.test(path)) {
    for (const m of code.matchAll(/^[ \t]*import\s+(?!type\b)([\s\S]*?)\s+from\s+["'][^"']+["']/gm)) {
      statements.push(m[0]);
      const spec = m[1];
      const ns = /\*\s+as\s+([\w$]+)/.exec(spec);
      if (ns) names.push(ns[1]);
      const braces = /\{([\s\S]*)\}/.exec(spec);
      if (braces) add(braces[1].replace(/\btype\s+/g, ""));
      const def = /^\s*([\w$]+)\s*(,|$)/.exec(spec);
      if (def) names.push(def[1]);
    }
    for (const m of code.matchAll(/^[ \t]*(?:const|let|var)\s+(\{[\s\S]*?\}|[\w$]+)\s*=\s*require\(\s*["'][^"']+["']\s*\)/gm)) {
      statements.push(m[0]);
      if (m[1].startsWith("{")) add(m[1].slice(1, -1));
      else names.push(m[1]);
    }
  }
  return { names: [...new Set(names)], statements };
}

/** Names this write imports newly that the rest of the file never mentions. */
export function unusedNewImports(path: string, before: string | undefined, after: string): string[] {
  // A package's __init__ imports to re-export.
  if (/(^|\/)__init__\.py$/.test(path) || !(PY_FILE.test(path) || JS_FILE.test(path))) return [];
  const had = new Set(imports(path, before ?? "").names);
  const now = imports(path, after);
  let rest = after;
  for (const s of now.statements) rest = rest.replace(s, "");
  // `_private` names are imported to re-export them (`from _decimal import __version__`).
  return now.names.filter((n) => !had.has(n) && !n.startsWith("_") && !new RegExp(`(?<![\\w$])${n.replace(/\$/g, "\\$")}(?![\\w$])`).test(rest));
}

/** A note for the write's result, or "". */
export function unusedImportNote(path: string, before: string | undefined, after: string): string {
  const names = unusedNewImports(path, before, after);
  if (!names.length) return "";
  const what = names.map((n) => `\`${n}\``).join(", ");
  return ` Note: ${path} imports ${what} but doesn't use ${names.length > 1 ? "them" : "it"} anywhere yet; if this todo needs ${names.length > 1 ? "them" : "it"}, the change isn't complete.`;
}
