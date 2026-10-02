import { cleanTerminalOutput, truncateOutput } from "./output";

export interface TestFailure {
  name: string;
  /** Workspace-relative when it lies under `root`. */
  file?: string;
  line?: number;
  message: string;
}

const clean = cleanTerminalOutput;
const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

/** Pulls failed tests out of jest/vitest, node:test (spec and TAP), pytest, unittest, dotnet test and cargo test output. */
export function parseTestFailures(output: string, root?: string): TestFailure[] {
  const text = clean(output);
  const found = [parseVitest, parseJest, parseNodeTest, parseTap, parsePytest, parseUnittest, parseDotnet, parseCargo].map((p) => p(text)).find((r) => r.length);
  return (found ?? []).map((f) => ({ ...f, file: f.file && relativize(f.file, root) }));
}

function relativize(file: string, root?: string): string {
  // Drive letters differ in case between VS Code (c:\) and Node's stack traces (C:\).
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^[a-z]:/, (d) => d.toUpperCase());
  const f = norm(file);
  const r = root && norm(root).replace(/\/$/, "");
  return r && f.startsWith(r + "/") ? f.slice(r.length + 1) : f;
}

function dedupe(list: TestFailure[]): TestFailure[] {
  const seen = new Set<string>();
  return list.filter((f) => !seen.has(f.name) && !!seen.add(f.name));
}

function parseVitest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(?:FAIL|×)\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+?)(?:\s+\d+ms)?$/.exec(lines[i]);
    if (!h) continue;
    let message = "";
    let file = h[1];
    let line: number | undefined;
    for (let j = i + 1; j < lines.length && j < i + 25 && !/^\s*(?:FAIL|×)\s/.test(lines[j]); j++) {
      const m = /^\s*(?:❯|>)\s+(\S+\.[cm]?[jt]sx?):(\d+):\d+/.exec(lines[j]);
      if (m && !line) [file, line] = [m[1], Number(m[2])];
      if (!message && /(Error|expected)/.test(lines[j]) && !/^\s*(?:❯|>)/.test(lines[j])) message = lines[j].trim();
    }
    out.push({ name: h[2], file, line, message });
  }
  return dedupe(out);
}

function parseJest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*● (.+?)\s*$/.exec(lines[i]);
    if (!h || /^(Console|Test suite failed to run)/.test(h[1])) continue;
    let message = "";
    let file: string | undefined;
    let line: number | undefined;
    for (let j = i + 1; j < lines.length && j < i + 40 && !/^\s*● /.test(lines[j]); j++) {
      if (!message && lines[j].trim()) message = lines[j].trim();
      const m = /at .*?\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(lines[j]);
      if (m && !file && !m[1].includes("node_modules")) [file, line] = [m[1], Number(m[2])];
    }
    out.push({ name: h[1], file, line, message });
  }
  return dedupe(out);
}

function parseNodeTest(text: string): TestFailure[] {
  const start = text.indexOf("✖ failing tests:");
  if (start < 0) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const out: TestFailure[] = [];
  let at: { file: string; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const t = /^test at (.+?):(\d+):\d+$/.exec(lines[i]);
    if (t) {
      at = { file: t[1], line: Number(t[2]) };
      continue;
    }
    const h = /^✖ (.+?)(?: \([\d.]+ms\))?$/.exec(lines[i]);
    if (!h) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !/^(?:✖ |test at )/.test(lines[i]); i++) body.push(lines[i]);
    i--;
    const first = body.findIndex((l) => l.trim());
    let message = first >= 0 ? body[first].trim() : "";
    // "Expected values to be strictly equal:" alone says nothing; the next line has the values.
    if (message.endsWith(":")) message += " " + (body.slice(first + 1).find((l) => l.trim())?.trim() ?? "");
    const loc = body.map((l) => /\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(l)).find((m) => m && !m[1].startsWith("node:") && /\bat\b/.test(m.input));
    out.push({ name: h[1], file: loc?.[1] ?? at?.file, line: loc ? Number(loc[2]) : at?.line, message });
    at = undefined;
  }
  return out;
}

/** `file:line` of a stack frame (`fn (C:\p\a.js:6:10)`, `at C:\p\a.js:6:10`) outside Node internals and node_modules. */
function userFrame(line: string): { file: string; line: number } | undefined {
  const m = /\(([^()]+):(\d+):\d+\)\s*$/.exec(line) ?? /^\s*(?:at\s+)?([^\s()][^()]*?):(\d+):\d+\s*$/.exec(line);
  if (!m || /^node:|node_modules|^<anonymous>$/.test(m[1].trim())) return undefined;
  return { file: m[1].trim(), line: Number(m[2]) };
}

/** Top-level `key: value` pairs of a TAP YAML block; block scalars (`|-`) and nested maps become their lines joined with \n. */
function tapFields(yaml: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const l of yaml) {
    const kv = /^([A-Za-z_]\w*):\s?(.*)$/.exec(l);
    if (kv) {
      key = kv[1];
      fields[key] = /^[|>][-+]?$/.test(kv[2]) ? "" : kv[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
    } else if (key) {
      fields[key] += (fields[key] ? "\n" : "") + l.replace(/^ {2}/, "");
    }
  }
  return fields;
}

/**
 * node:test's TAP output: the default reporter when stdout is not a terminal, so what the agent
 * gets from `node --test` and `npm test`. `not ok N - name` is followed by a YAML block with the
 * error and stack; a test file that fails to load reports only "test failed", with the real error
 * in the `#` comment lines before it.
 */
function parseTap(text: string): TestFailure[] {
  if (!/^TAP version \d+/m.test(text)) return [];
  const lines = text.split("\n");
  const out: TestFailure[] = [];
  let comments: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^(\s*)not ok \d+ - (.*?)\s*(?:#\s*(?:TODO|SKIP)\b.*)?$/i.exec(lines[i]);
    if (!h) {
      if (/^\s*ok \d+/.test(lines[i])) comments = [];
      else if (/^\s*#/.test(lines[i]) && !/^\s*# Subtest:/.test(lines[i])) comments.push(lines[i].replace(/^\s*#\s?/, ""));
      continue;
    }
    const indent = h[1].length + 2;
    const yaml: string[] = [];
    if (lines[i + 1]?.trim() === "---") {
      for (i += 2; i < lines.length && lines[i].trim() !== "..."; i++) yaml.push(lines[i].slice(indent));
    }
    const f = tapFields(yaml);
    const before = comments;
    comments = [];
    if (f.failureType === "subtestsFailed") continue; // a suite: its failing tests are listed themselves
    let message = (f.error ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    if (f.name && f.name !== "AssertionError" && message && !message.startsWith(f.name)) message = `${f.name}: ${message}`;
    let frame = (f.stack ?? "").split("\n").map(userFrame).find(Boolean);
    if (!message || message === "test failed") {
      // The file itself failed (a syntax error, a require that throws): the error was printed before.
      const err = before.find((l) => /^\w*Error\b.*?:/.test(l.trim()));
      if (err) message = err.trim();
      frame ??= before.map(userFrame).find(Boolean);
    }
    const location = /^(.*):(\d+):\d+$/.exec((f.location ?? "").replace(/\\\\/g, "\\"));
    out.push({
      name: h[2].replace(/\\\\/g, "\\"),
      file: frame?.file.replace(/\\\\/g, "\\") ?? location?.[1],
      line: frame?.line ?? (location ? Number(location[2]) : undefined),
      message,
    });
  }
  return dedupe(out);
}

function parsePytest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  const heads = lines.map((l, i) => ({ m: /^_{2,} (.+?) _{2,}$/.exec(l), i })).filter((h) => h.m);
  for (let k = 0; k < heads.length; k++) {
    const block = lines.slice(heads[k].i + 1, heads[k + 1]?.i ?? lines.length);
    const loc = [...block].reverse().map((l) => /^(\S+\.py):(\d+): /.exec(l)).find(Boolean);
    const err = block.find((l) => /^E\s+\S/.test(l));
    if (loc || err) out.push({ name: heads[k].m![1], file: loc?.[1], line: loc ? Number(loc[2]) : undefined, message: err?.replace(/^E\s+/, "").trim() ?? "" });
  }
  if (out.length) return dedupe(out);
  for (const l of lines) {
    const m = /^(?:FAILED|ERROR) (\S+?)::(\S+?)(?: - (.*))?$/.exec(l);
    if (m) out.push({ name: m[2], file: m[1], message: m[3] ?? "" });
  }
  return dedupe(out);
}

function parseUnittest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  for (const block of text.split(/^={60,}$/m).slice(1)) {
    const h = /^\s*(FAIL|ERROR): (\S+) \((.+)\)/.exec(block);
    if (!h) continue;
    const body = block.split(/\n-{60,}\n(?:Ran \d+ test|$)/)[0].split(/\n-{60,}\n/).slice(1).join("\n");
    const frames = [...body.matchAll(/File "([^"]+)", line (\d+)/g)].filter((f) => !/[\\/]lib[\\/]python|unittest/.test(f[1]));
    const frame = frames[frames.length - 1];
    const lastLine = body.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
    out.push({ name: h[2], file: frame?.[1], line: frame ? Number(frame[2]) : undefined, message: lastLine.trim() });
  }
  return out;
}

function parseDotnet(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(?:Failed|X)\s+(\S+)(?:\s+\[[^\]]*\])?\s*$/.exec(lines[i]);
    if (!h) continue;
    const msg: string[] = [];
    let file: string | undefined;
    let line: number | undefined;
    let mode: "none" | "msg" | "stack" = "none";
    for (let j = i + 1; j < lines.length && !/^\s*(?:Failed|X|Passed)\s+\S+/.test(lines[j]); j++) {
      const l = lines[j];
      if (/^\s*Error Message:/.test(l)) mode = "msg";
      else if (/^\s*Stack Trace:/.test(l)) mode = "stack";
      else if (mode === "msg" && l.trim() && msg.length < 3) msg.push(l.trim());
      else if (mode === "stack" && !file) {
        const m = /in (.+?):line (\d+)/.exec(l);
        if (m) [file, line] = [m[1], Number(m[2])];
      }
    }
    out.push({ name: h[1], file, line, message: msg.join(" ").replace(/\s+/g, " ") });
  }
  return dedupe(out);
}

function parseCargo(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^---- (\S+) stdout ----$/.exec(lines[i]);
    if (!h) continue;
    for (let j = i + 1; j < lines.length && !/^---- /.test(lines[j]); j++) {
      const modern = /panicked at (\S+?):(\d+):\d+:?$/.exec(lines[j]);
      if (modern) {
        out.push({ name: h[1], file: modern[1], line: Number(modern[2]), message: lines[j + 1]?.trim() ?? "" });
        break;
      }
      const old = /panicked at '(.*)', (\S+?):(\d+):\d+/.exec(lines[j]);
      if (old) {
        out.push({ name: h[1], file: old[2], line: Number(old[3]), message: old[1] });
        break;
      }
    }
  }
  return out;
}

export function formatTestFailures(failures: TestFailure[], limit = 10): string {
  const rows = failures.slice(0, limit).map((f, i) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : "";
    return `${i + 1}. ${where}${f.name}${f.message ? `: ${clip(f.message)}` : ""}`;
  });
  const more = failures.length > limit ? [`... and ${failures.length - limit} more`] : [];
  return [`Failing tests (${failures.length}):`, ...rows, ...more].join("\n");
}

/**
 * `file(line,col): error` (MSBuild, tsc), `file:line:col: ...` (Go, gcc, node, tsc --pretty false),
 * `File "x.py", line N`, and JavaScript stack frames `fn (file.js:line:col)`.
 */
const LOCATIONS = [
  /^\s*(.+?\.(?:cs|fs|vb|tsx?))\((\d+),\d+\): error\b/gm,
  /^\s*(?:\.\/)?([\w./\\:-]+?\.(?:go|[cm]?[jt]sx?|rs|c|cc|cpp|h|java|kt|py)):(\d+)(?::\d+)?:? /gm,
  /File "([^"]+\.py)", line (\d+)/g,
  /\(([^()\n]+?\.[cm]?[jt]sx?):(\d+):\d+\)/g,
];

/**
 * The code around the first few error locations in `output`, numbered, for workspace files:
 * the compiler names the line, but small models fix the line they were thinking of instead
 * (a constructor, while the error is the field two lines above). Failed tests come first: the
 * assertion line says what was called (`s.peek()`), which the bare "1 !== 2" doesn't.
 */
export async function errorContext(output: string, root: string, read: (path: string) => Promise<string>, max = 3): Promise<string> {
  const locations: { file: string; line: number }[] = [];
  for (const f of parseTestFailures(output, root)) if (f.file && f.line) locations.push({ file: f.file, line: f.line });
  for (const re of LOCATIONS) for (const m of output.matchAll(re)) locations.push({ file: relativize(m[1].trim().replace(/\\\\/g, "\\"), root), line: Number(m[2]) });
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const { file, line } of locations) {
    if (blocks.length >= max) break;
    if (/^([a-zA-Z]:)?\//.test(file) || /node_modules|site-packages|[\\/]lib[\\/]python/.test(file)) continue;
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = await read(file).catch(() => undefined);
    if (text === undefined) continue;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const from = Math.max(1, line - 2);
    const to = Math.min(lines.length, line + 2);
    blocks.push(`${file}:\n${lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}${from + i === line ? " >" : " |"} ${l}`).join("\n")}`);
  }
  return blocks.length ? `\n\nCode at the errors:\n${blocks.join("\n")}` : "";
}

/** `def f(..., tags=[])`: a default created once and shared by every call (flake8-bugbear B006). */
const MUTABLE_DEFAULT = /^([ \t]*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\))/gm;
const MUTABLE_VALUE = /(\w+)\s*(?::[^=,]+)?=\s*(\[\s*\]|\{\s*\}|list\(\)|dict\(\)|set\(\))/g;

/**
 * Well-known bug patterns in the source files a failing run involves, as "possible cause" notes:
 * the kind of thing a linter points at and a small model doesn't think of. Test files are skipped.
 */
export async function lintHints(files: Iterable<string>, read: (path: string) => Promise<string>, max = 3): Promise<string> {
  const notes: string[] = [];
  for (const file of files) {
    if (!/\.py$/.test(file) || /(^|\/)(tests?_[^/]*|[^/]*_tests?\.py|tests?\/)/.test(file)) continue;
    const text = (await read(file).catch(() => "")).replace(/\r\n/g, "\n");
    for (const m of text.matchAll(MUTABLE_DEFAULT)) {
      for (const d of m[3].matchAll(MUTABLE_VALUE)) {
        if (notes.length >= max) break;
        const line = text.slice(0, m.index).split("\n").length;
        notes.push(
          `${file}:${line} \`${m[1].trim()}\`: the default \`${d[1]}=${d[2]}\` is created once, when the function is defined, and every call without \`${d[1]}\` shares ` +
            `(and changes) that same object. Use \`${d[1]}=None\` and create a new one inside the function.`,
        );
      }
    }
  }
  return notes.length ? `\n\nPossible cause (static check):\n${notes.join("\n")}` : "";
}

/**
 * Output of a failed command, shaped for the model: the parsed failure list first,
 * then a shortened log. Unrecognized output is only truncated.
 */
export function failureReport(output: string, root?: string, maxLines = 120): string {
  const failures = parseTestFailures(output, root);
  if (!failures.length) return truncateOutput(output, maxLines);
  return `${formatTestFailures(failures)}\n\nLog (shortened):\n${truncateOutput(output, Math.min(maxLines, 40))}`;
}
