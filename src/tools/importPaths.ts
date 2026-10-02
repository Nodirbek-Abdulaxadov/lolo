import * as path from "node:path";
import type { FileChange, Host } from "../host/types";
import { search } from "./search";
import { filesWithWord } from "./symbolTools";
import type { ToolContext } from "./types";

/**
 * Import updates after a file move, done by code: models search for the old path as
 * written in the workspace ("src/utils/format"), but code imports it relatively
 * ("./utils/format"), so they conclude nothing needs changing.
 *
 * JS/TS: relative `require()`, `import ... from`, `export ... from`, `import()`.
 * Python: absolute module names (`from pkg.mod import x`, `import pkg.mod`).
 */

const JS_FILE = /\.(c|m)?(j|t)sx?$/;
const JS_EXT = [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const JS_SPEC = /(\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|^\s*import\s+)(['"])(\.{1,2}\/[^'"\n]*)\2/gm;

/** What a relative specifier in `importer` points to, as a workspace path, if it is one of `candidates`. */
export function resolveSpec(importer: string, spec: string, exists: (p: string) => boolean): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
  for (const p of [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)]) if (exists(p)) return p;
  return undefined;
}

/** A specifier from `importer` to `target`, in the style of `old` (extension or not, index or not). */
function specFor(importer: string, target: string, old: string): string {
  let rel = path.posix.relative(path.posix.dirname(importer), target);
  const ext = path.posix.extname(target);
  if (/\/index\.[^/]+$/.test(target) && !/\/index(\.[^/]+)?$/.test(old)) rel = path.posix.dirname(rel);
  else if (!path.posix.extname(old) && ext) rel = rel.slice(0, -ext.length);
  if (rel === "" || rel === ".") rel = ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function pyModule(file: string): string | undefined {
  if (!file.endsWith(".py")) return undefined;
  return file.slice(0, -3).replace(/\/__init__$/, "").split("/").join(".");
}

/** The ways text refers to a file: `billing/utils.py`, `billing/utils`, `utils/format`, `billing.utils`. */
function pathForms(file: string): string[] {
  const noExt = file.replace(/\.[^./]+$/, "");
  const parts = noExt.split("/");
  const forms = [file, noExt];
  if (parts.length >= 2) forms.push(parts.slice(-2).join("/"));
  if (file.endsWith(".py") && parts.length >= 2) forms.push(noExt.replace(/\/__init__$/, "").split("/").join("."));
  return [...new Set(forms)];
}

/** Whether `todo` names `file` (as a path, an import path or a Python module). */
export function mentionsPath(todo: string, file: string): boolean {
  return pathForms(file).some((f) => todo.includes(f));
}

/**
 * Whether code still points at the old place of a moved file: its last two path segments
 * (`utils/format`, as relative imports write it) or its Python module (`billing.utils`).
 * A file at the root can't be told apart from other uses of its name: true (the model checks).
 */
export async function stillReferenced(ctx: ToolContext, from: string): Promise<boolean> {
  const noExt = from.replace(/\.[^./]+$/, "");
  const parts = noExt.split("/");
  if (parts.length < 2) return true;
  const needles = [parts.slice(-2).join("/"), ...(from.endsWith(".py") ? [parts.join(".")] : [])];
  for (const query of needles) {
    const r = await search.run({ query }, ctx);
    if (!r.ok) return true;
    if (r.output.startsWith("No matches")) continue;
    const files = r.output.split("\n").map((l) => l.slice(0, Math.max(0, l.indexOf(":")))).filter((f) => /\.((c|m)?(j|t)sx?|py)$/.test(f));
    if (files.length) return true;
  }
  return false;
}

/**
 * New contents for files whose imports pointed at `from` (moved to `to`), including the moved
 * file's own relative imports. `before` lists the workspace files as they were before the move.
 */
export async function importUpdates(ctx: ToolContext, from: string, to: string, before: Set<string>): Promise<FileChange[]> {
  const host: Host = ctx.host;
  const out: FileChange[] = [];
  const oldExists = (p: string) => before.has(p);
  const moved = (p: string) => (p === from ? to : p);

  if (JS_FILE.test(from)) {
    const stem = path.posix.basename(from).replace(/\.[^.]+$/, "");
    const importers = new Set([...(await filesWithWord(ctx, stem === "index" ? path.posix.basename(path.posix.dirname(from)) : stem)), to]);
    for (const f of importers) {
      if (!JS_FILE.test(f)) continue;
      const oldPath = f === to ? from : f; // the moved file resolves its imports from where it was
      const text = await host.readFile(f).catch(() => undefined);
      if (text === undefined) continue;
      const next = text.replace(JS_SPEC, (m, pre: string, q: string, spec: string) => {
        const target = resolveSpec(oldPath, spec, oldExists);
        if (!target) return m;
        const now = moved(target);
        if (f !== to && now === target) return m; // unrelated import
        const updated = specFor(f, now, spec);
        return updated === spec ? m : `${pre}${q}${updated}${q}`;
      });
      if (next !== text) out.push({ path: f, content: next });
    }
  }

  const oldMod = pyModule(from);
  const newMod = pyModule(to);
  if (oldMod && newMod && oldMod !== newMod) {
    const last = oldMod.split(".").pop()!;
    const esc = oldMod.replace(/\./g, "\\.");
    const re = new RegExp(`^(\\s*(?:from|import)\\s+)${esc}(?=[\\s.,;]|$)`, "gm");
    // `import pkg.mod` is used as `pkg.mod.name(...)`: those qualified uses change too.
    const plainImport = new RegExp(`^\\s*import\\s+${esc}\\s*$`, "m");
    const qualified = new RegExp(`(?<![\\w.])${esc}\\.(?=[A-Za-z_])`, "g");
    for (const f of await filesWithWord(ctx, last)) {
      if (!f.endsWith(".py")) continue;
      const text = await host.readFile(f).catch(() => undefined);
      if (text === undefined) continue;
      let next = text.replace(re, `$1${newMod}`);
      if (plainImport.test(text)) next = next.replace(qualified, `${newMod}.`);
      if (next !== text) out.push({ path: f, content: next });
    }
  }
  return out;
}
