import { detectEol, fromLf, leadingWs, levenshtein, normalizeWs, numberLines, toLf } from "./text";

export const FUZZY_THRESHOLD = 0.85;
/** A second non-overlapping window this close to the best one makes a fuzzy match ambiguous. */
const AMBIGUITY_MARGIN = 0.05;

export type ApplyResult =
  | {
      ok: true;
      content: string;
      strategy: "exact" | "whitespace" | "fuzzy";
      score: number;
      startLine: number;
      /** With all=true: the start line of every replaced occurrence. */
      replaced?: number[];
    }
  | {
      ok: false;
      reason: string;
      closest?: { startLine: number; text: string; score: number };
      /** 1-based start lines when `search` matched more than one place (pass one back as `at`). */
      matches?: number[];
      /** The change is already in the file: nothing to apply (a no-op, not a failed match). */
      alreadyApplied?: boolean;
    };

/**
 * Replaces `search` with `replace` in `content`, trying exact → whitespace-normalized
 * → fuzzy (line-wise similarity ≥ 0.85). Non-exact matches re-indent `replace` to the
 * indentation actually found in the file. `at` picks one of several matches by its start line;
 * `within` limits all=true to occurrences starting in that line range.
 */
export function fuzzyApply(content: string, search: string, replace: string, opts: { all?: boolean; at?: number; within?: [number, number] } = {}): ApplyResult {
  const eol = detectEol(content);
  const text = toLf(content);
  search = trimBlankEdges(toLf(search));
  replace = toLf(replace);
  if (!search.trim()) return { ok: false, reason: "`search` is empty. Quote the exact lines to replace." };
  if (opts.all && !text.includes(search)) return { ok: false, reason: "With all=true, `search` must match the file exactly; it was not found." };

  // 1. exact
  const first = text.indexOf(search);
  if (first >= 0 && opts.all) {
    let out = "";
    let from = 0;
    const replaced: number[] = [];
    for (let i = first; i >= 0; i = text.indexOf(search, i + search.length)) {
      const line = lineOf(text, i);
      if (opts.within && (line < opts.within[0] || line > opts.within[1])) continue;
      out += text.slice(from, i) + replace;
      from = i + search.length;
      replaced.push(line);
    }
    out += text.slice(from);
    return { ok: true, content: fromLf(out, eol), strategy: "exact", score: 1, startLine: replaced[0] ?? lineOf(text, first), replaced };
  }
  // An append/prepend edit (`replace` contains `search`) whose result is already in place: applying it again duplicates code.
  const replaced = trimBlankEdges(replace);
  if (first >= 0 && replaced.length > search.length && replaced.includes(search)) {
    const lead = replaced.indexOf(search);
    for (let i = first; i >= 0; i = text.indexOf(search, i + 1)) {
      if (i >= lead && text.startsWith(replaced, i - lead)) {
        return { ok: false, alreadyApplied: true, reason: "The file already contains `replace` at that place: this change is already applied. Re-read the file before editing again." };
      }
    }
  }
  if (first >= 0) {
    const hits: number[] = [];
    for (let i = first; i >= 0; i = text.indexOf(search, i + 1)) hits.push(i);
    const at = hits.length > 1 ? hits.find((i) => lineOf(text, i) === opts.at) : first;
    if (at === undefined) {
      return {
        ok: false,
        reason: "`search` matches more than one place. Include more surrounding lines to make it unique, or set all=true to replace every occurrence.",
        matches: hits.map((i) => lineOf(text, i)),
      };
    }
    const content = text.slice(0, at) + trimBlankEdges(replace) + text.slice(at + search.length);
    return { ok: true, content: fromLf(content, eol), strategy: "exact", score: 1, startLine: lineOf(text, at) };
  }

  // A stale `search` whose replacement is already in the file: the change was made
  // earlier. Fuzzy-matching it would hit the already-edited lines.
  const replaceTrimmed = trimBlankEdges(replace);
  if (replaceTrimmed.trim() && (text.includes(replaceTrimmed) || normalizeWs(text).includes(normalizeWs(replaceTrimmed)))) {
    // A short `replace` (`return x;`) may just occur elsewhere: that says little about this change.
    const alreadyApplied = replaceTrimmed.replace(/\s/g, "").length >= 25;
    return { ok: false, alreadyApplied, reason: "The file already contains `replace` and not `search`: this change is already applied. Re-read the file before editing again." };
  }

  const lines = text.split("\n");
  const searchLines = search.split("\n");
  const n = searchLines.length;

  // 2. whitespace-normalized
  const normSearch = searchLines.map(normalizeWs);
  const normLines = lines.map(normalizeWs);
  const wsHits: number[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    if (normSearch.every((s, k) => s === normLines[i + k])) wsHits.push(i);
  }
  const wsAt = wsHits.length === 1 ? wsHits[0] : wsHits.find((i) => i + 1 === opts.at);
  if (wsAt !== undefined) return splice(lines, wsAt, n, searchLines, replace, eol, "whitespace", 1);
  if (wsHits.length > 1) {
    return { ok: false, reason: "`search` matches more than one place (ignoring whitespace). Include more surrounding lines.", matches: wsHits.map((i) => i + 1) };
  }

  // 3. fuzzy: best window of the same line count, scored by character edit
  // distance over the whole window so short lines like `}` don't inflate it.
  const searchChars = normSearch.reduce((a, l) => a + l.length, 0);
  const scores: number[] = [];
  let best = { start: -1, score: 0 };
  for (let i = 0; i + n <= lines.length; i++) {
    let dist = 0;
    let chars = 0;
    for (let k = 0; k < n; k++) {
      dist += levenshtein(normSearch[k], normLines[i + k]);
      chars += Math.max(normSearch[k].length, normLines[i + k].length);
    }
    const score = chars === 0 ? 0 : 1 - dist / Math.max(chars, searchChars);
    scores.push(score);
    if (score > best.score) best = { start: i, score };
  }
  if (best.start >= 0 && best.score >= FUZZY_THRESHOLD) {
    const rival = scores.some((s, i) => Math.abs(i - best.start) >= n && best.score - s < AMBIGUITY_MARGIN);
    if (rival) {
      return { ok: false, reason: "`search` is similar to more than one place in the file. Copy the lines exactly and include more context." };
    }
    return splice(lines, best.start, n, searchLines, replace, eol, "fuzzy", best.score);
  }

  const closest =
    best.start >= 0
      ? { startLine: best.start + 1, text: numberLines(lines.slice(best.start, best.start + n), best.start + 1), score: round(best.score) }
      : undefined;
  return {
    ok: false,
    reason: "`search` was not found in the file. Copy the lines exactly as they appear in the file.",
    closest,
  };
}

/**
 * Small models often repeat, at the end of `replace`, the lines that follow `search` in the
 * file (typically the block's closing `}`), or at its start the lines before it; applied as
 * is, that duplicates them and breaks the syntax. Given the file before and after an applied
 * edit (the replacement starts at `startLine` and replaced `searchLines` lines), returns
 * versions where those lines are replaced instead of duplicated, biggest overlap first.
 */
export function overlapCandidates(original: string, applied: string, startLine: number, searchLines: number): string[] {
  const eol = detectEol(original);
  const orig = toLf(original).split("\n");
  const next = toLf(applied).split("\n");
  const s = startLine - 1;
  const m = next.length - orig.length + searchLines; // lines of the replacement as applied
  if (s < 0 || m < 2) return [];
  const repl = next.slice(s, s + m);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => normalizeWs(l) === normalizeWs(b[i])) && a.some((l) => l.trim());
  const after = orig.slice(s + searchLines);
  const before = orig.slice(0, s);
  let tail = 0;
  for (let k = Math.min(m - 1, after.length); k > 0 && !tail; k--) if (same(repl.slice(-k), after.slice(0, k))) tail = k;
  let head = 0;
  for (let k = Math.min(m - 1 - tail, before.length); k > 0 && !head; k--) if (same(repl.slice(0, k), before.slice(-k))) head = k;
  const build = (h: number, t: number) => fromLf([...before.slice(0, before.length - h), ...repl, ...after.slice(t)].join("\n"), eol);
  const out: string[] = [];
  if (head && tail) out.push(build(head, tail));
  if (tail) out.push(build(0, tail));
  if (head) out.push(build(head, 0));
  return out;
}

/** `target = value` (also `self.x`, `this.x`); not `==`, `+=`, declarations. */
const ASSIGNS = /^\s*((?:self\.|this\.)?[A-Za-z_$][\w$.]*)\s*(?::\s*[^=]+)?=(?!=)/;

/**
 * `replace` ends by re-typing the lines that follow `search`, some changed: `search` was a function's
 * first line and `replace` that line plus its body with one assignment changed. Applied as is, the
 * old lines stay below the new ones (valid code in Python, where the old `self.tags = tags` then
 * overrides the new one). Given the file before and after an applied edit, returns the version where
 * those old lines are replaced: at least two lines, each identical or filling the same slot (the same
 * assignment target, or both `return`), at least one identical.
 */
export function retypedTail(original: string, applied: string, startLine: number, searchLines: number): string | undefined {
  const eol = detectEol(original);
  const orig = toLf(original).split("\n");
  const next = toLf(applied).split("\n");
  const s = startLine - 1;
  const m = next.length - orig.length + searchLines;
  const repl = next.slice(s, s + m);
  const after = orig.slice(s + searchLines);
  // The slot a line fills: what it assigns to, or the function's `return`.
  const target = (l: string) => ASSIGNS.exec(l)?.[1] ?? (/^\s*return\b/.test(l) ? "return" : undefined);
  for (let k = Math.min(m - 1, after.length); k >= 2; k--) {
    const tail = repl.slice(-k);
    const old = after.slice(0, k);
    let identical = 0;
    const fits = tail.every((l, i) => {
      if (normalizeWs(l) === normalizeWs(old[i])) return l.trim() ? ++identical > 0 : true;
      return !!target(l) && target(l) === target(old[i]);
    });
    if (fits && identical > 0 && identical < k) return fromLf([...orig.slice(0, s), ...repl, ...after.slice(k)].join("\n"), eol);
  }
  return undefined;
}

/**
 * `search` is only the first line(s) of a block (`test("adds", () => {`, `if (x) {`) and `replace` a
 * complete block: the old block, then a new one after it, or a new version of it. Applied as is, the
 * old block's body stays behind with an extra `});`. Returns the file with the replacement covering
 * the whole old block, up to where the brackets `search` opens close again; lines right after the
 * block that `replace` repeats at its end are not duplicated. The caller keeps it only if it parses.
 */
export function blockCandidates(original: string, startLine: number, search: string, replace: string, imbalance: (text: string) => unknown): string[] {
  const eol = detectEol(original);
  const lines = toLf(original).split("\n");
  const s = startLine - 1;
  const searchLines = trimBlankEdges(toLf(search)).split("\n");
  const repl = trimBlankEdges(toLf(replace));
  if (s < 0 || !imbalance(searchLines.join("\n")) || imbalance(repl)) return [];
  const last = Math.min(lines.length, s + 400);
  for (let k = s + searchLines.length; k < last; k++) {
    if (imbalance(lines.slice(s, k + 1).join("\n"))) continue;
    const replLines = repl.split("\n");
    const after = lines.slice(k + 1);
    let repeated = 0;
    for (let n = Math.min(replLines.length - 1, after.length); n > 0 && !repeated; n--) {
      const tail = replLines.slice(-n);
      if (tail.some((l) => l.trim()) && tail.every((l, i) => normalizeWs(l) === normalizeWs(after[i]))) repeated = n;
    }
    const body = reindent(repl, searchLines, lines.slice(s, s + searchLines.length));
    return [fromLf([...lines.slice(0, s), ...body.slice(0, body.length - repeated), ...after].join("\n"), eol)];
  }
  return [];
}

function splice(
  lines: string[],
  start: number,
  n: number,
  searchLines: string[],
  replace: string,
  eol: "\r\n" | "\n",
  strategy: "whitespace" | "fuzzy",
  score: number,
): ApplyResult {
  const reindented = reindent(replace, searchLines, lines.slice(start, start + n));
  const out = [...lines.slice(0, start), ...reindented, ...lines.slice(start + n)];
  return { ok: true, content: fromLf(out.join("\n"), eol), strategy, score: round(score), startLine: start + 1 };
}

/**
 * Shifts `replace` by the indentation difference between what the model quoted and
 * what the file actually has (first non-blank line of each).
 */
export function reindent(replace: string, searchLines: string[], actualLines: string[]): string[] {
  const replaceLines = trimBlankEdges(replace).split("\n");
  if (!replace.trim()) return [];
  const k = searchLines.findIndex((l) => l.trim());
  if (k < 0) return replaceLines;
  const quoted = leadingWs(searchLines[k]);
  const actual = leadingWs(actualLines[k] ?? "");
  if (quoted === actual) return replaceLines;
  if (actual.startsWith(quoted)) {
    // File is indented deeper than quoted: add the difference everywhere.
    const add = actual.slice(quoted.length);
    return replaceLines.map((l) => (l.trim() ? add + l : l));
  }
  if (quoted.startsWith(actual)) {
    // File is indented shallower: strip the difference where present.
    const cut = quoted.slice(actual.length);
    return replaceLines.map((l) => (l.startsWith(cut) ? l.slice(cut.length) : l));
  }
  // Different indent characters (tabs vs spaces): swap the quoted prefix.
  return replaceLines.map((l) => (l.startsWith(quoted) ? actual + l.slice(quoted.length) : l));
}

function trimBlankEdges(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}
