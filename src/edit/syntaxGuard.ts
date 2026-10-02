import { syntaxError, withTree } from "../context/treeSitter";

/**
 * Regex escapes in normal C# strings: `"[\s-]+"` fails the build with CS1009 (C# knows only `\n`,
 * `\t`, `\\` ... there), and models can't see why the "correct" pattern fails. The backslash is
 * doubled by code (`"[\\s-]+"`); verbatim (`@"..."`) and raw strings are left alone. Invalid escapes
 * never compile, so this can only help.
 */
export async function fixCSharpEscapes(path: string, text: string): Promise<{ text: string; fixed: number }> {
  if (!/\.cs$/i.test(path) || !text.includes("\\")) return { text, fixed: 0 };
  const spots =
    (await withTree(path, text, (root) =>
      root
        .descendantsOfType(["string_literal_content"])
        .filter((n) => n?.parent?.type === "string_literal")
        .flatMap((n) => [...n!.text.matchAll(/\\(?=[^\\'"0abefnrtuUvx\n])/g)].map((m) => n!.startIndex + m.index!)),
    )) ?? [];
  let out = text;
  for (const at of [...spots].sort((a, b) => b - a)) out = out.slice(0, at) + "\\" + out.slice(at);
  return { text: out, fixed: spots.length };
}

/**
 * Cheap structural check for brace languages until tree-sitter lands: an edit that
 * takes a file from balanced to unbalanced brackets is almost always a broken
 * splice (7B models often drop or duplicate a closing brace).
 */
const BRACE_LANG = /\.(ts|tsx|js|jsx|mjs|cjs|cs|java|kt|go|rs|c|h|cpp|hpp|cc|swift|php|dart|scala|json|jsonc)$/i;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

export interface Imbalance {
  line: number;
  message: string;
}

/** First bracket problem in `text`, skipping strings and comments; undefined when balanced. */
export function findImbalance(text: string): Imbalance | undefined {
  const stack: { ch: string; line: number }[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] === "\n") line++;
      i--;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // Verbatim/raw strings (C# @"..", Rust r"..") are close enough to plain ones for balance purposes.
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "\n") {
          line++;
          if (c !== "`") break; // unterminated single-line string: stop scanning it
        }
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push({ ch: c, line });
    else if (c in PAIRS) {
      const top = stack.pop();
      if (!top) return { line, message: `unexpected '${c}' at line ${line}` };
      if (top.ch !== PAIRS[c]) return { line, message: `'${top.ch}' opened at line ${top.line} is closed by '${c}' at line ${line}` };
    }
  }
  const open = stack.pop();
  return open ? { line: open.line, message: `'${open.ch}' opened at line ${open.line} is never closed` } : undefined;
}

/**
 * Error text when an edit breaks a file that parsed cleanly before; else undefined.
 * Uses tree-sitter where a grammar exists, bracket balance otherwise.
 */
export async function checkEditSyntax(path: string, before: string | undefined, after: string, fragment?: string): Promise<string | undefined> {
  const afterErr = await syntaxError(path, after);
  const problem = afterErr === null ? checkEditStructure(path, before, after) : afterErr && !(before !== undefined && (await syntaxError(path, before))) ? afterErr : undefined;
  if (!problem) return undefined;
  const cut = fragment !== undefined ? cutOffLine(fragment) : undefined;
  if (cut) {
    return (
      `Your code stops in the middle of a line: \`${cut.slice(-80)}\`. A double quote inside the code was probably not escaped as \\" in your JSON reply, ` +
      "which ended the string early. The file was NOT changed. Write it again and escape every \" inside the code (avoid C# verbatim strings @\"...\"; use normal strings with escapes)."
    );
  }
  if (afterErr === null) return problem;
  const view = around(after, problem);
  return `This change would introduce a syntax error (${problem}). The file was NOT changed.${view ? `\n${view}\n` : " "}Re-read the file and make an edit that keeps the code valid.`;
}

/**
 * Rewrites for syntax mistakes small models repeat, tried when a write doesn't parse; the
 * caller keeps one only if it parses. C#: a file-scoped `namespace X;` followed by a braced
 * block (the two namespace styles mixed up) becomes `namespace X { ... }`.
 */
export function syntaxRepairs(path: string, text: string): { text: string; note: string }[] {
  const out: { text: string; note: string }[] = [];
  if (/\.cs$/i.test(path)) {
    const m = /^([ \t]*namespace[ \t]+[\w.]+)[ \t]*;([ \t]*\r?\n[ \t]*\{)/m.exec(text);
    if (m) out.push({ text: text.slice(0, m.index) + m[1] + m[2] + text.slice(m.index + m[0].length), note: "`namespace X;` can't be followed by braces, so it became `namespace X { ... }`" });
  }
  return out;
}

/** The would-be file around the error line, numbered, so the model sees e.g. a duplicated `});`. */
function around(text: string, problem: string): string {
  const line = Number(/^line (\d+)/.exec(problem)?.[1]);
  if (!line) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const from = Math.max(1, line - 4);
  const to = Math.min(lines.length, line + 2);
  const view = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}${from + i === line ? " >" : " |"} ${l}`);
  return `The result would have been (lines ${from}-${to}):\n${view.join("\n")}`;
}

/** The last line when it looks cut off (open string, dangling `@`/operator), else undefined. */
export function cutOffLine(text: string): string | undefined {
  const last = text.replace(/\s+$/, "").split("\n").pop() ?? "";
  const quotes = (last.replace(/\\./g, "").match(/"/g) ?? []).length;
  return quotes % 2 === 1 || /(@|\$|[(,=+]|\\)$/.test(last) ? last.trim() : undefined;
}

/** Error text when the edit breaks bracket balance of a previously balanced file; else undefined. */
export function checkEditStructure(path: string, before: string | undefined, after: string): string | undefined {
  if (!BRACE_LANG.test(path)) return undefined;
  if (before !== undefined && findImbalance(before)) return undefined; // was already unbalanced (or our lexer can't read it)
  const problem = findImbalance(after);
  return problem ? `This change would leave the brackets unbalanced: ${problem.message}. The file was NOT changed. Re-read the file and make an edit that keeps every block complete.` : undefined;
}
