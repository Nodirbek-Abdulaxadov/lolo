import type { ModelProfile } from "../providers/modelProfiles";
import { detectEol, fromLf, normalizeWs, toLf } from "./text";

/** Edit tools the model can be offered. Which ones are live is decided per step. */
export type EditTool = "edit" | "rewrite_file" | "edit_lines";

/** Search-replace failures on one file before that file switches to line-range edits. */
export const LINE_RANGE_AFTER_FAILURES = 2;

/** Per-run edit-format state: tracks search-replace failures and line-range fallbacks. */
export class EditState {
  private failures = new Map<string, number>();
  private lineRange = new Set<string>();

  /** Records a failed search-replace; returns true when this pushes the file to line-range mode. */
  recordFailure(path: string): boolean {
    const n = (this.failures.get(path) ?? 0) + 1;
    this.failures.set(path, n);
    if (n >= LINE_RANGE_AFTER_FAILURES && !this.lineRange.has(path)) {
      this.lineRange.add(path);
      return true;
    }
    return false;
  }

  forceLineRange(path: string) {
    this.lineRange.add(path);
  }

  recordSuccess(path: string) {
    this.failures.delete(path);
  }

  isLineRange(path: string) {
    return this.lineRange.has(path);
  }

  get anyLineRange() {
    return this.lineRange.size > 0;
  }
}

export function enabledEditTools(profile: ModelProfile, state: EditState): EditTool[] {
  switch (profile.editFormat) {
    case "whole":
      return ["rewrite_file"];
    case "search-replace":
      return state.anyLineRange ? ["edit", "edit_lines"] : ["edit"];
    case "line-range":
      return ["edit_lines"];
    case "auto":
      return state.anyLineRange ? ["edit", "rewrite_file", "edit_lines"] : ["edit", "rewrite_file"];
  }
}

/**
 * The edit tool the model must use for a given file: line-range once the file fell
 * back, whole-file for small files in auto mode, search-replace otherwise.
 */
export function editToolFor(profile: ModelProfile, state: EditState, path: string, lineCount: number): EditTool {
  if (profile.editFormat === "line-range" || state.isLineRange(path)) return "edit_lines";
  if (profile.editFormat === "whole") return "rewrite_file";
  if (profile.editFormat === "search-replace") return "edit";
  return lineCount <= profile.wholeFileMaxLines ? "rewrite_file" : "edit";
}

// ---------------------------------------------------------------------------
// Lazy-edit protection for whole-file rewrites

const COMMENT_EDGES = /^(?:\/\/+|#+|\/\*+|<!--|--|;+|\*)\s*|\s*(?:\*+\/|-->)$/g;
const LAZY_WORDS = /\b(existing|rest|remain(?:s|ing|der)?|unchanged|same|previous|other|omitted|keep|as before)\b/i;

/**
 * True for lines like `// ... existing code ...` or `# rest of the file unchanged`.
 * A bare `...` only counts when the original file has no such line (Python stubs use it).
 */
export function isLazyPlaceholder(line: string, originalTrimmed: Set<string>): boolean {
  const t = line.trim();
  if (!t || originalTrimmed.has(t)) return false;
  const hadComment = t.replace(COMMENT_EDGES, "") !== t;
  const body = t.replace(COMMENT_EDGES, "").trim();
  if (body === "..." || body === "…") return true;
  if (!hadComment) return false;
  const hasEllipsis = body.includes("...") || body.includes("…");
  return (hasEllipsis && (LAZY_WORDS.test(body) || body.replace(/[.…\s]/g, "") === "")) ||
    /^(the )?(rest of|remaining|existing|other)\b.*\b(code|file|methods?|functions?|implementation|unchanged|same)\b/i.test(body);
}

const ELIDED_BODY = /\{\s*(?:\.\.\.|…)\s*\}/;
const STUB_COMMENT = /^(?:.*\b(?:logic|code|implementation|body)\s+(?:goes\s+)?here|todo:?\s*implement\b.*|implement\b.*\bhere)[.!:]?$/i;

/**
 * True for a body the model left out of new code: `function f(x) { ... }`, or a comment like
 * `// validation logic here` / `# TODO: implement` right after the line that opens the body
 * (`previous`), which tells it apart from a section comment above real code.
 */
export function isStub(line: string, previous: string | undefined, originalTrimmed: Set<string>): boolean {
  const t = line.trim();
  if (!t || originalTrimmed.has(t)) return false;
  if (ELIDED_BODY.test(t)) return true;
  const body = t.replace(COMMENT_EDGES, "").trim();
  return body !== t && STUB_COMMENT.test(body) && /(?:\{|:|=>)$/.test(previous?.trim() ?? "");
}

export type MergeResult = { ok: true; content: string; filled: number } | { ok: false; reason: string };

/**
 * Fills lazy placeholders in a whole-file rewrite with the corresponding original
 * lines, anchored on the nearest real lines before and after each placeholder.
 */
export function mergeLazyRewrite(original: string, proposed: string): MergeResult {
  const eol = detectEol(original);
  const orig = toLf(original).split("\n");
  const prop = toLf(proposed).split("\n");
  const origSet = new Set(orig.map((l) => l.trim()));
  const origNorm = orig.map(normalizeWs);

  if (!prop.some((l) => isLazyPlaceholder(l, origSet))) return { ok: true, content: proposed, filled: 0 };
  // The "placeholder" is just a comment when the rewrite already contains (nearly) every
  // original line, e.g. "// Existing tests..." above the tests rewritten with other quotes.
  // Filling it would duplicate code and break the file.
  if (coverage(orig, prop) >= 0.9) return { ok: true, content: proposed, filled: 0 };

  const out: string[] = [];
  let cursor = 0; // next original line not yet consumed
  let sinceFill = 0; // index in `out` where lines emitted after the last fill start
  let filled = 0;
  for (let i = 0; i < prop.length; i++) {
    if (!isLazyPlaceholder(prop[i], origSet)) {
      out.push(prop[i]);
      continue;
    }
    // Anchor before: nearest line emitted since the last fill that exists in the original.
    let from = cursor;
    for (let j = out.length - 1; j >= sinceFill; j--) {
      if (!out[j].trim()) continue;
      const at = findFrom(origNorm, normalizeWs(out[j]), cursor);
      if (at >= 0) {
        from = at + 1;
        break;
      }
    }
    // Anchor after: first later real line that exists in the original; new lines
    // before it end up after the filled region.
    let to = orig.length;
    for (const l of prop.slice(i + 1)) {
      if (!l.trim() || isLazyPlaceholder(l, origSet)) continue;
      const at = findFrom(origNorm, normalizeWs(l), from);
      if (at >= 0) {
        to = at;
        break;
      }
      if (origSet.has(l.trim())) return fail(l); // exists, but only before this point: order is broken
    }
    // Don't double blank lines the proposal already has around the placeholder.
    if (out.length && !out[out.length - 1].trim()) while (from < to && !orig[from].trim()) from++;
    if (i + 1 < prop.length && !prop[i + 1].trim()) while (to > from && !orig[to - 1].trim()) to--;
    out.push(...orig.slice(from, to));
    filled++;
    cursor = to;
    sinceFill = out.length;
  }
  return { ok: true, content: fromLf(out.join("\n"), eol), filled };
}

/** Share of the original's non-blank lines that appear in `proposed` (ignoring whitespace and quote style). */
function coverage(orig: string[], proposed: string[]): number {
  const norm = (l: string) => normalizeWs(l).replace(/["'`]/g, '"');
  const have = new Set(proposed.map(norm));
  const lines = orig.filter((l) => l.trim());
  return lines.length ? lines.filter((l) => have.has(norm(l))).length / lines.length : 0;
}

function fail(anchor: string): MergeResult {
  return {
    ok: false,
    reason:
      `Your rewrite contains placeholders like "// ... existing code ..." but the line \`${anchor.trim()}\` ` +
      "is out of order relative to the original file, so the omitted code cannot be restored. " +
      "Write the complete file with no placeholders, or use `edit` for a targeted change.",
  };
}

function findFrom(lines: string[], needle: string, from: number) {
  for (let i = from; i < lines.length; i++) if (lines[i] === needle) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Line-range edits

export type LineRangeResult = { ok: true; content: string } | { ok: false; reason: string };

/**
 * Replaces lines start..end (1-based, inclusive) with `replacement`.
 * `end = start - 1` inserts before `start` without removing anything.
 */
/** `target = value` (also `self.x`, `this.x`, a Python annotation); not `==`, `+=`, declarations. */
const ASSIGNMENT = /^\s*((?:self\.|this\.)?[A-Za-z_$][\w$.]*)\s*(?::\s*[^=]+)?=(?!=)\s*(.*)$/;

/** What a line assigns to, unless its value uses the target itself (`x = x + 1` is a second step, not a new version). */
function assignedTarget(line: string | undefined): string | undefined {
  const m = line === undefined ? null : ASSIGNMENT.exec(line);
  if (!m) return undefined;
  return new RegExp(`(?<![\\w$.])${m[1].replace(/[.$]/g, "\\$&")}(?![\\w$])`).test(m[2]) ? undefined : m[1];
}

/**
 * An edit_lines range one line short: `content` ends with a new assignment to what the line after the
 * range assigns (`self.tags = tags if tags is not None else []` above the old `self.tags = tags`), or
 * starts with one to what the line before it assigns. The old line would override the new one, so the
 * range is widened to replace it.
 */
export function widenForReassignment(original: string, start: number, end: number, content: string): { start: number; end: number } {
  const lines = toLf(original).split("\n");
  const repl = toLf(content).split("\n").filter((l) => l.trim());
  if (!repl.length || end < start) return { start, end };
  const last = assignedTarget(repl[repl.length - 1]);
  const first = assignedTarget(repl[0]);
  return {
    start: first && start > 1 && assignedTarget(lines[start - 2]) === first ? start - 1 : start,
    end: last && end < lines.length && assignedTarget(lines[end]) === last ? end + 1 : end,
  };
}

export function applyLineRange(original: string, start: number, end: number, replacement: string): LineRangeResult {
  const eol = detectEol(original);
  const lines = toLf(original).split("\n");
  const total = lines.length;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false, reason: "start_line and end_line must be integers." };
  if (start < 1 || start > total + 1) return { ok: false, reason: `start_line must be between 1 and ${total + 1}.` };
  if (end < start - 1 || end > total) return { ok: false, reason: `end_line must be between ${start - 1} (insert) and ${total}.` };
  const repl = replacement === "" ? [] : toLf(replacement).replace(/\n$/, "").split("\n");
  const out = [...lines.slice(0, start - 1), ...repl, ...lines.slice(end)];
  return { ok: true, content: fromLf(out.join("\n"), eol) };
}
