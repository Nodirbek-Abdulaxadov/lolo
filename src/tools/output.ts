const ERROR_LINE = /\b(error|errors|fail(ed|ure)?|exception|panic|traceback|cannot|undefined reference|not found)\b|✗|✘|FAIL\b|\bE\d{3,}\b|\bCS\d{4}\b|\bTS\d{4}\b/i;

/** Terminal control sequences: CSI (incl. private modes like `ESC[?25l`), OSC, charset/keypad switches. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
/** Progress-only lines, e.g. the MSBuild terminal logger's `(0.3s)` timers. */
const PROGRESS = /^\s*(\(\d+(\.\d+)?s\)|[|/\\-])\s*$/;

/**
 * Command output as plain text for the model: escape sequences removed, `\r`
 * progress redraws reduced to their final state, timer lines and repeats dropped.
 */
export function cleanTerminalOutput(text: string): string {
  const out: string[] = [];
  for (const raw of text.replace(ESCAPES, "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.includes("\r") ? raw.slice(raw.lastIndexOf("\r", raw.length - 2) + 1).replace(/\r$/, "") : raw;
    if (PROGRESS.test(line)) continue;
    if (line.trim() && line === out[out.length - 1]) continue;
    out.push(line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Shortens long command output to head + tail, keeping error lines from the
 * middle in full: they are what the repair step needs.
 */
export function truncateOutput(text: string, maxLines = 120): string {
  const lines = cleanTerminalOutput(text).split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  const head = Math.floor(maxLines * 0.3);
  const tail = Math.floor(maxLines * 0.45);
  const middle = lines.slice(head, lines.length - tail);
  const errors = middle.filter((l) => ERROR_LINE.test(l)).slice(0, maxLines - head - tail);
  const omitted = middle.length - errors.length;
  return [
    ...lines.slice(0, head),
    `... [${omitted} lines omitted${errors.length ? `; ${errors.length} error lines kept below` : ""}] ...`,
    ...errors,
    ...(errors.length ? ["..."] : []),
    ...lines.slice(lines.length - tail),
  ].join("\n");
}

/**
 * Absolute paths inside the workspace → workspace-relative with forward slashes: shorter,
 * and what the tools take (`C:\Users\me\app\src\A.cs(3,5)` → `src/A.cs(3,5)`).
 */
export function relativizePaths(text: string, root: string): string {
  // Also `C:\\Users\\me\\app` as quoted in node:test's TAP output.
  const variants = [...new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\"), root.replace(/[\\/]/g, "\\\\")])].map((v) => v.replace(/[\\/]+$/, ""));
  let out = text;
  for (const v of variants.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]+([^\\s:()\\[\\]'"]*)`, /^[a-zA-Z]:/.test(v) ? "gi" : "g");
    out = out.replace(re, (_, rest: string) => rest.replace(/\\+/g, "/"));
  }
  return out;
}

/** Cheap symbol summary for compaction notes, e.g. "class UserService, fn getById". */
export function symbolSummary(text: string, max = 5): string {
  const names: string[] = [];
  const re = /\b(class|interface|enum|struct|record|trait|function|def|func|fn)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && names.length < max) names.push(`${m[1]} ${m[2]}`);
  return names.join(", ");
}
