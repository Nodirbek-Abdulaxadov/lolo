import { withTree, type SyntaxNode } from "../context/treeSitter";

/**
 * JavaScript mistakes that parse, so the syntax guard lets them through, but throw as soon as the
 * code runs, often in a path the project's tests don't cover:
 * - the same `let`/`const` twice in one block (Node refuses the whole file);
 * - a name used in its own `const`/`let` declaration (`const tax = tax(a)` after importing `tax`);
 * - a new reference to a variable the file doesn't define (`computeTax(amount)` where the callback
 *   calls it `a`), in module files only (scripts may share globals).
 * Only problems the write introduces count. TypeScript is left to its compiler.
 */

const JS_FILE = /\.(c|m)?jsx?$/;
const MODULE = /\brequire\s*\(|\bmodule\.exports\b|\bexports\.\w+\s*=|^\s*(?:import|export)\b/m;

const FUNCTIONS = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition", "class_body"]);

/** Names every JavaScript environment the agent meets defines: the language, Node, browsers, test runners. */
const GLOBALS = new Set(
  (
    "undefined NaN Infinity globalThis arguments eval isNaN isFinite parseInt parseFloat encodeURI encodeURIComponent decodeURI decodeURIComponent escape unescape " +
    // The global object inherits Object.prototype: `hasOwnProperty.call(o, k)` works unqualified.
    "hasOwnProperty isPrototypeOf propertyIsEnumerable toString toLocaleString valueOf " +
    "innerWidth innerHeight outerWidth outerHeight pageXOffset pageYOffset scrollX scrollY devicePixelRatio origin print importScripts msCrypto " +
    "Object Function Array String Number Boolean Symbol BigInt Date RegExp Math JSON Promise Proxy Reflect Intl Map Set WeakMap WeakSet WeakRef FinalizationRegistry " +
    "Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError ArrayBuffer SharedArrayBuffer DataView Atomics " +
    "Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array " +
    "console process require module exports __dirname __filename Buffer global setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate " +
    "queueMicrotask structuredClone fetch Request Response Headers FormData Blob File FileReader URL URLSearchParams AbortController AbortSignal " +
    "TextEncoder TextDecoder crypto performance atob btoa Event EventTarget CustomEvent MessageChannel BroadcastChannel WebSocket Worker " +
    "window document navigator location history localStorage sessionStorage alert confirm prompt self frames parent top screen " +
    "requestAnimationFrame cancelAnimationFrame getComputedStyle matchMedia MutationObserver IntersectionObserver ResizeObserver XMLHttpRequest Image Audio " +
    "HTMLElement Element Node NodeList customElements indexedDB caches " +
    "describe it test expect beforeEach afterEach beforeAll afterAll before after suite setup teardown suiteSetup suiteTeardown jest vi context specify xit xdescribe fit fdescribe " +
    "cy Cypress browser page chrome $ jQuery _ React ReactDOM Vue angular"
  ).split(" "),
);

const same = (a: SyntaxNode | null | undefined, b: SyntaxNode) => !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
const field = (n: SyntaxNode, name: string) => n.childForFieldName(name);

/** Whether identifier `n` declares a name (rather than using one). Plain assignments count, as implicit globals. */
function isBinding(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  switch (p.type) {
    case "variable_declarator":
    case "function_declaration":
    case "generator_function_declaration":
    case "function_expression":
    case "function":
    case "generator_function":
    case "class_declaration":
    case "class":
      return same(field(p, "name"), n);
    case "arrow_function":
      return same(field(p, "parameter"), n);
    case "formal_parameters":
    case "array_pattern":
    case "object_pattern":
    case "rest_pattern":
    case "import_clause":
    case "import_specifier":
    case "namespace_import":
      return true;
    case "pair_pattern":
      return same(field(p, "value"), n);
    case "assignment_pattern":
    case "assignment_expression":
      return same(field(p, "left"), n);
    case "catch_clause":
      return same(field(p, "parameter"), n);
    case "for_in_statement":
      return same(field(p, "left"), n);
    default:
      return false;
  }
}

/** A use whose target may legitimately be defined elsewhere or later: a call, `new X`, `typeof x`, JSX, export lists. */
function isLenientUse(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return true;
  if (p.type === "call_expression") return same(field(p, "function"), n);
  if (p.type === "new_expression") return same(field(p, "constructor"), n);
  if (p.type === "unary_expression") return field(p, "operator")?.type === "typeof";
  return p.type.startsWith("jsx_") || p.type === "export_specifier" || p.type === "namespace_export";
}

function descendants(root: SyntaxNode, types: string[]): SyntaxNode[] {
  return root.descendantsOfType(types).filter((n): n is SyntaxNode => !!n);
}

/** `const x = ... x ...` outside nested functions: the inner `x` is the new binding, still uninitialized. */
function selfReferences(root: SyntaxNode): { name: string; line: number; text: string }[] {
  const out: { name: string; line: number; text: string }[] = [];
  for (const decl of descendants(root, ["lexical_declaration"])) {
    for (const d of decl.namedChildren) {
      if (!d || d.type !== "variable_declarator") continue;
      const name = field(d, "name");
      const value = field(d, "value");
      if (!name || name.type !== "identifier" || !value) continue;
      const uses = descendants(value, ["identifier"]).filter((id) => {
        if (id.text !== name.text || isBinding(id)) return false;
        for (let a = id.parent; a; a = a.parent) {
          if (FUNCTIONS.has(a.type)) return false; // runs later, when the variable is initialized
          if (same(a, value)) break;
        }
        return true;
      });
      if (uses.length) out.push({ name: name.text, line: d.startPosition.row + 1, text: `${decl.child(0)?.text ?? "const"} ${d.text}`.split("\n")[0].slice(0, 100) });
    }
  }
  return out;
}

/**
 * Names a pattern (`x`, `{ a, b: [c] }`, parameters) binds; not those of functions in its default
 * values (`{ duration = (d) => d * 30 }` binds `duration`, not `d`).
 */
function patternNames(pattern: SyntaxNode): SyntaxNode[] {
  if (pattern.type === "identifier") return [pattern];
  return descendants(pattern, ["identifier", "shorthand_property_identifier_pattern"]).filter((n) => {
    if (n.type === "identifier" && !isBinding(n)) return false;
    for (let a = n.parent; a && !same(a, pattern); a = a.parent) if (FUNCTIONS.has(a.type)) return false;
    return true;
  });
}

/** Names a `let`/`const` declaration (or a class) binds, patterns included. */
function declaredNames(stmt: SyntaxNode): SyntaxNode[] {
  if (stmt.type === "class_declaration") return [field(stmt, "name")].filter((n): n is SyntaxNode => !!n);
  if (stmt.type !== "lexical_declaration") return [];
  return stmt.namedChildren
    .filter((d): d is SyntaxNode => !!d && d.type === "variable_declarator")
    .flatMap((d) => {
      const name = field(d, "name");
      return name ? patternNames(name) : [];
    });
}

/**
 * The same name declared twice with `let`/`const`/`class` in one block, or again at the top of a
 * function body that has it as a parameter: Node refuses to load the file ("Identifier 'i' has
 * already been declared"), while the grammar is fine with it.
 */
function redeclarations(root: SyntaxNode): { name: string; line: number; first: number }[] {
  const out: { name: string; line: number; first: number }[] = [];
  for (const scope of [root, ...descendants(root, ["statement_block"])]) {
    const names = new Map<string, number>();
    const fn = scope.parent && FUNCTIONS.has(scope.parent.type) ? scope.parent : undefined;
    const params = fn && (field(fn, "parameters") ?? field(fn, "parameter"));
    if (params) for (const p of patternNames(params)) names.set(p.text, p.startPosition.row + 1);
    for (const stmt of scope.namedChildren) {
      if (!stmt) continue;
      for (const n of declaredNames(stmt)) {
        const first = names.get(n.text);
        if (first !== undefined) out.push({ name: n.text, line: n.startPosition.row + 1, first });
        else names.set(n.text, n.startPosition.row + 1);
      }
    }
  }
  return out;
}

const IMPORT_LINE = /^(import\b|(const|let|var)\b.*=\s*require\()/;

/** Parameter names of the functions around `n`, innermost first. */
function paramsAround(n: SyntaxNode): string[] {
  const names: string[] = [];
  for (let a = n.parent; a; a = a.parent) {
    if (!FUNCTIONS.has(a.type)) continue;
    const params = field(a, "parameters") ?? field(a, "parameter");
    if (params) for (const id of patternNames(params)) names.push(id.text);
  }
  return [...new Set(names)];
}

interface Undefined {
  name: string;
  line: number;
  params: string[];
}

/** References to names the file declares nowhere and no environment defines, with where they are. */
function undefinedNames(root: SyntaxNode): Undefined[] {
  const declared = new Set<string>();
  const refs: SyntaxNode[] = [];
  for (const n of descendants(root, ["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"])) {
    if (n.type === "shorthand_property_identifier_pattern" || (n.type === "identifier" && isBinding(n))) declared.add(n.text);
    // `typeof x === "number" ? x : 0` guards the other uses of an optional global.
    else if (n.type === "identifier" && n.parent?.type === "unary_expression" && field(n.parent, "operator")?.type === "typeof") declared.add(n.text);
    else if (n.type === "shorthand_property_identifier" || !isLenientUse(n)) refs.push(n);
  }
  const out: Undefined[] = [];
  for (const r of refs) {
    if (declared.has(r.text) || GLOBALS.has(r.text) || !/^[a-z][A-Za-z0-9]*$/.test(r.text) || out.some((u) => u.name === r.text)) continue;
    out.push({ name: r.text, line: r.startPosition.row + 1, params: paramsAround(r) });
  }
  return out;
}

/** Advice for the first runtime error the write would introduce in a JavaScript file, else undefined. */
export async function jsRuntimeProblem(path: string, before: string | undefined, after: string): Promise<string | undefined> {
  if (!JS_FILE.test(path)) return undefined;
  const found = await withTree(path, after, (root) =>
    root.hasError ? undefined : { again: redeclarations(root), self: selfReferences(root), undef: MODULE.test(after) ? undefinedNames(root) : [] },
  );
  if (!found) return undefined;
  const lineOf = (n: number) => after.replace(/\r\n/g, "\n").split("\n")[n - 1]?.trim().slice(0, 120) ?? "";
  // What the file already had: its own problems, and names it used without defining (globals of its environment).
  const had =
    before === undefined
      ? undefined
      : await withTree(path, before, (root) => ({ again: redeclarations(root).map((r) => r.name), self: selfReferences(root).map((s) => s.text), undef: undefinedNames(root).map((u) => u.name) }));

  const again = found.again.find((r) => !had?.again.includes(r.name));
  if (again) {
    const first = lineOf(again.first);
    // A second import of a name: renaming one of them ("importedValidateEmail") breaks the code that uses it.
    if (IMPORT_LINE.test(first) && IMPORT_LINE.test(lineOf(again.line))) {
      // The one the file had before is the existing import, wherever the new one went.
      const hadLines = new Set((before ?? "").replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()));
      const [old, added] = hadLines.has(lineOf(again.line)) && !hadLines.has(first) ? [again.line, again.first] : [again.first, again.line];
      return (
        `\`${again.name}\` is already imported at line ${old}: \`${lineOf(old)}\`, so the new line ${added} (\`${lineOf(added)}\`) would declare it twice ` +
        `("Identifier '${again.name}' has already been declared"). Don't add a second import: if it should now come from another module, change line ${old}; ` +
        `if line ${old} is already right, this change is done. The file was NOT changed.`
      );
    }
    return (
      `\`${again.name}\` is declared a second time in the same block (line ${again.line}: \`${lineOf(again.line)}\`; line ${again.first} already declares it: \`${first}\`): ` +
      `Node refuses to load the file ("Identifier '${again.name}' has already been declared"). Use the existing \`${again.name}\`, or give the new one another name. The file was NOT changed.`
    );
  }
  const self = found.self.find((s) => !had?.self.includes(s.text));
  if (self) {
    return (
      `\`${self.name}\` is used in its own declaration (line ${self.line}: \`${lineOf(self.line)}\`). Inside it, \`${self.name}\` is the new ` +
      `variable, not the one outside, so this line throws ReferenceError. Give one of them another name. The file was NOT changed.`
    );
  }
  const undef = found.undef.find((u) => !had?.undef.includes(u.name));
  if (undef) {
    const params = undef.params.length ? ` The enclosing function's parameters are: ${undef.params.map((p) => `\`${p}\``).join(", ")}.` : "";
    return (
      `\`${undef.name}\` is not defined in ${path} (line ${undef.line}: \`${lineOf(undef.line)}\`), so this line would throw ReferenceError.${params} ` +
      `Use a name that exists there, or define \`${undef.name}\` first. The file was NOT changed.`
    );
  }
  return undefined;
}
