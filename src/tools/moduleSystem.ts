import { listFiles } from "../context/repoMap";
import { resolveSpec } from "./importPaths";
import { filesWithWord } from "./symbolTools";
import type { ToolContext } from "./types";

const ESM = /^\s*(?:export\s+(?:\*|default\b|const\b|let\b|var\b|function\b|async\b|class\b|\{)|import\s+(?:[\w*{][^'"]*\s+from\s+)?['"])/m;
const CJS = /\brequire\s*\(\s*['"]|\bmodule\.exports\b|^\s*exports\.\w+\s*=/m;
// The user asked for the other module system: a conversion is the task, not a mistake.
const CONVERTS = /\b(?:ESM|ES ?modules?|ECMAScript modules?|CommonJS|CJS)\b|import\/export|"type":\s*"module"/i;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const LITERALS = new Set(["true", "false", "null", "undefined", "this", "NaN", "Infinity", "require", "module", "exports", "console", "process"]);

/**
 * Names a JavaScript file exports (`module.exports = { a, b }`, `export { a }`) without defining,
 * importing or requiring them: after a refusal, models wrote only `module.exports = { computeTax };`.
 */
export function undefinedExports(path: string, text: string): string[] {
  if (!/\.(c|m)?jsx?$/.test(path)) return [];
  const lists = [...text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g), ...text.matchAll(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm)].map((m) => m[1]);
  const names = lists.flatMap((l) =>
    l.split(",").map((item) => {
      const [key, value] = item.split(/\s+as\s+|:/).map((s) => s.trim());
      return /\s+as\s+/.test(item) ? key : (value ?? key);
    }),
  );
  const escape = (n: string) => n.replace(/\$/g, "\\$");
  return [...new Set(names.filter((n) => IDENT.test(n) && !LITERALS.has(n)))].filter((n) => {
    const e = escape(n);
    return !new RegExp(
      String.raw`\b(?:function\*?|class|const|let|var)\s+${e}\b|\b(?:const|let|var)\s*[{[][^}\]]*\b${e}\b[^}\]]*[}\]]\s*=|^\s*${e}\s*=|\bimport\b[^;]*\b${e}\b[^;]*\bfrom\b`,
      "m",
    ).test(text);
  });
}

/** What the last `module.exports = ...` of a file assigns: an object of names, or one value (a class, a function). */
function exportShape(text: string): "object" | "value" | undefined {
  const all = [...text.matchAll(/^\s*module\.exports\s*=\s*(\S)/gm)];
  const last = all[all.length - 1];
  return last ? (last[1] === "{" ? "object" : "value") : undefined;
}

const REQUIRE_OBJECT = /\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const REQUIRE_VALUE = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)(?!\s*[.[(])/g;

/**
 * A CommonJS file whose export changes shape while other files load it the old way:
 * `module.exports = { Cart }` → `module.exports = Cart` breaks `const { Cart } = require("./cart")`
 * ("Cart is not a constructor"), and the other way round. Models rewrite the export line from memory
 * during renames. Advice naming the importer, or undefined.
 */
export async function exportShapeProblem(path: string, before: string, after: string, ctx: ToolContext): Promise<string | undefined> {
  if (!/\.c?js$/.test(path)) return undefined;
  const was = exportShape(before);
  const now = exportShape(after);
  if (!was || !now || was === now) return undefined;
  const files = new Set(await listFiles(ctx.host));
  const stem = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const pattern = was === "object" ? REQUIRE_OBJECT : REQUIRE_VALUE;
  for (const f of await filesWithWord(ctx, stem === "index" ? path.split("/").slice(-2, -1)[0] ?? stem : stem)) {
    if (f === path || !/\.(c|m)?jsx?$/.test(f)) continue;
    const text = await ctx.host.readFile(f).catch(() => "");
    for (const m of text.matchAll(pattern)) {
      if (resolveSpec(f, m[2], (p) => files.has(p)) !== path) continue;
      const exported = /^\s*module\.exports\s*=.*$/m.exec(before)?.[0].trim() ?? "";
      return `${f} loads ${path} with \`${m[0].trim()}\`, which needs the export as it was (\`${exported}\`); after this change it would get ${was === "object" ? "undefined" : "an object"}. Leave the export as it is. The file was NOT changed.`;
    }
  }
  return undefined;
}

/**
 * A whole file written with export/import turned into CommonJS by code, for the plain forms models
 * write (`export function f`, `export const x`, `export { a }`, `import { a } from "./m"`); undefined
 * for anything else (default exports, re-exports, `module.exports` already there). Planners put
 * "export function ..." into the todo itself, and the model followed it through every refusal.
 */
export function toCommonJs(text: string): string | undefined {
  if (/\bmodule\.exports\b|^\s*export\s+default\b|^\s*export\s*\*|^\s*export\s*\{[^}]*\}\s*from\b/m.test(text)) return undefined;
  const names: string[] = [];
  let out = text.replace(/^(\s*)export\s+((?:async\s+)?function\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm, (_m, indent: string, kind: string, name: string) => {
    names.push(name);
    return `${indent}${kind}${name}`;
  });
  out = out.replace(/^\s*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (_m, list: string) => {
    for (const item of list.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [local, as] = item.split(/\s+as\s+/);
      names.push(as ? `${as}: ${local}` : local);
    }
    return "";
  });
  const bindings = (list: string) => list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ": ")).join(", ");
  out = out
    .replace(/^(\s*)import\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])\s*;?/gm, (_m, indent: string, list: string, from: string) => `${indent}const { ${bindings(list)} } = require(${from});`)
    .replace(/^(\s*)import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*(['"][^'"]+['"])\s*;?/gm, (_m, indent: string, name: string, from: string) => `${indent}const ${name} = require(${from});`);
  if (/^\s*(?:export|import)\b/m.test(out) || out === text) return undefined;
  return names.length ? `${out.replace(/\s*$/, "")}\n\nmodule.exports = { ${names.join(", ")} };\n` : out;
}

/** The nearest package.json above `path` (workspace-relative), or undefined. */
async function nearestPackage(path: string, ctx: ToolContext): Promise<string | undefined> {
  const parts = path.split("/").slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const p = [...parts.slice(0, i), "package.json"].join("/");
    if ((await ctx.host.stat(p)) === "file") return p;
  }
  return undefined;
}

/**
 * New code in the other module system than the project's: `export` in a CommonJS project (models
 * write "exported from" as ESM) or `require` in a `"type": "module"` one. Node then fails, and
 * small models convert the whole project instead of the one file. Advice, or undefined.
 * `before` is the file's current content ("" for a new file): its own style stays allowed.
 */
export async function moduleSystemProblem(path: string, content: string, before: string, ctx: ToolContext): Promise<string | undefined> {
  return (await moduleSystemMismatch(path, content, before, ctx))?.advice;
}

/** As moduleSystemProblem, with the module system the file must use. */
export async function moduleSystemMismatch(
  path: string,
  content: string,
  before: string,
  ctx: ToolContext,
): Promise<{ wants: "commonjs" | "module"; advice: string } | undefined> {
  const ext = path.match(/\.(c|m)?js$/)?.[1] ?? (path.endsWith(".js") ? "" : undefined);
  if (ext === undefined || CONVERTS.test(ctx.todo ?? "")) return undefined;
  const esm = ESM.test(content) && !ESM.test(before);
  const cjs = CJS.test(content) && !CJS.test(before);
  if (!esm && !cjs) return undefined;

  const pkg = await nearestPackage(path, ctx);
  let type: string | undefined;
  try {
    type = pkg ? JSON.parse(await ctx.host.readFile(pkg)).type : undefined;
  } catch {
    return undefined;
  }
  const projectEsm = ext === "m" || (ext === "" && type === "module");
  if (projectEsm && cjs) {
    const where = ext === "m" ? `${path} is an ES module (.mjs)` : `${pkg} has "type": "module"`;
    return { wants: "module", advice: `${where}, so require and module.exports are not defined here. Use \`export function name\` / \`export { name }\` and \`import { name } from "./file.js"\`.` };
  }
  if (!esm || projectEsm) return undefined;
  if (ext === "" && type !== "commonjs") {
    // No "type": the project's own files decide (bundled front-end code uses import/export without it).
    const code = (await listFiles(ctx.host)).filter((f) => /\.js$/.test(f) && f !== path && !/(^|\/)(dist|build|out)\//.test(f)).slice(0, 12);
    let cjsFiles = 0;
    for (const f of code) {
      const text = await ctx.host.readFile(f).catch(() => "");
      if (ESM.test(text)) return undefined;
      if (CJS.test(text)) cjsFiles++;
    }
    if (!cjsFiles) return undefined;
  }
  const why = ext === "c" ? `${path} is a CommonJS file (.cjs)` : `This project uses CommonJS (require and module.exports; ${pkg ? `${pkg} has no "type": "module"` : "no package.json"})`;
  return { wants: "commonjs", advice: `${why}, so export/import would fail in Node. Export with \`module.exports = { name }\` and load it with \`const { name } = require("./file")\`, like the other files do.` };
}
