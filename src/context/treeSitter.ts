import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { Language as TSLanguage, Node as TSNode, Parser as TSParser, Query as TSQuery } from "@vscode/tree-sitter-wasm";

/**
 * tree-sitter (WASM) wrapper: symbol definitions and references for the repo map,
 * and parse-error detection for the edit syntax guard. Grammars come from
 * @vscode/tree-sitter-wasm (the same builds VS Code uses); the build copies them to
 * dist/wasm.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TS: typeof import("@vscode/tree-sitter-wasm") = require("@vscode/tree-sitter-wasm/wasm/tree-sitter.js");

interface LangSpec {
  wasm: string;
  defs: string[];
  /** Node types whose text counts as a reference to a symbol name. */
  refs: string[];
}

const TS_DEFS = [
  "(class_declaration name: (_) @name) @def",
  "(abstract_class_declaration name: (_) @name) @def",
  "(interface_declaration name: (_) @name) @def",
  "(type_alias_declaration name: (_) @name) @def",
  "(enum_declaration name: (_) @name) @def",
  "(function_declaration name: (_) @name) @def",
  "(method_definition name: (_) @name) @def",
  "(method_signature name: (_) @name) @def",
  "(program (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @def)",
  "(export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @def)",
];
const TS_REFS = ["identifier", "type_identifier", "property_identifier"];

const LANGS: Record<string, LangSpec> = {
  typescript: { wasm: "tree-sitter-typescript.wasm", defs: TS_DEFS, refs: TS_REFS },
  tsx: { wasm: "tree-sitter-tsx.wasm", defs: TS_DEFS, refs: TS_REFS },
  javascript: { wasm: "tree-sitter-javascript.wasm", defs: TS_DEFS, refs: TS_REFS },
  csharp: {
    wasm: "tree-sitter-c-sharp.wasm",
    defs: [
      "(class_declaration name: (identifier) @name) @def",
      "(interface_declaration name: (identifier) @name) @def",
      "(struct_declaration name: (identifier) @name) @def",
      "(record_declaration name: (identifier) @name) @def",
      "(enum_declaration name: (identifier) @name) @def",
      "(method_declaration name: (identifier) @name) @def",
      "(constructor_declaration name: (identifier) @name) @def",
      "(property_declaration name: (identifier) @name) @def",
    ],
    refs: ["identifier"],
  },
  python: {
    wasm: "tree-sitter-python.wasm",
    defs: ["(class_definition name: (identifier) @name) @def", "(function_definition name: (identifier) @name) @def"],
    refs: ["identifier"],
  },
  go: {
    wasm: "tree-sitter-go.wasm",
    defs: [
      "(function_declaration name: (identifier) @name) @def",
      "(method_declaration name: (field_identifier) @name) @def",
      "(type_spec name: (type_identifier) @name) @def",
    ],
    refs: ["identifier", "type_identifier", "field_identifier"],
  },
  java: {
    wasm: "tree-sitter-java.wasm",
    defs: [
      "(class_declaration name: (identifier) @name) @def",
      "(interface_declaration name: (identifier) @name) @def",
      "(enum_declaration name: (identifier) @name) @def",
      "(record_declaration name: (identifier) @name) @def",
      "(method_declaration name: (identifier) @name) @def",
    ],
    refs: ["identifier", "type_identifier"],
  },
  rust: {
    wasm: "tree-sitter-rust.wasm",
    defs: [
      "(function_item name: (identifier) @name) @def",
      "(function_signature_item name: (identifier) @name) @def",
      "(struct_item name: (type_identifier) @name) @def",
      "(enum_item name: (type_identifier) @name) @def",
      "(trait_item name: (type_identifier) @name) @def",
    ],
    refs: ["identifier", "type_identifier", "field_identifier"],
  },
  cpp: {
    wasm: "tree-sitter-cpp.wasm",
    defs: [
      "(class_specifier name: (type_identifier) @name) @def",
      "(struct_specifier name: (type_identifier) @name) @def",
      "(function_definition declarator: (function_declarator declarator: (_) @name)) @def",
    ],
    refs: ["identifier", "type_identifier", "field_identifier"],
  },
  php: {
    wasm: "tree-sitter-php.wasm",
    defs: ["(class_declaration name: (name) @name) @def", "(function_definition name: (name) @name) @def", "(method_declaration name: (name) @name) @def"],
    refs: ["name"],
  },
  ruby: {
    wasm: "tree-sitter-ruby.wasm",
    defs: ["(class name: (_) @name) @def", "(module name: (_) @name) @def", "(method name: (_) @name) @def"],
    refs: ["identifier", "constant"],
  },
};

const EXT: Record<string, keyof typeof LANGS> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".cs": "csharp", ".py": "python", ".go": "go", ".java": "java", ".rs": "rust",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".h": "cpp",
  ".php": "php", ".rb": "ruby",
};

export function languageFor(file: string): string | undefined {
  return EXT[path.extname(file).toLowerCase()];
}

interface Loaded {
  language: TSLanguage;
  parser: TSParser;
  defs: TSQuery[];
  refs: Set<string>;
}

let initPromise: Promise<void> | undefined;
const loaded = new Map<string, Promise<Loaded | undefined>>();

/** dist/wasm when bundled; the package folder when running from source (tests). */
function wasmDir(): string {
  const bundled = path.join(__dirname, "wasm");
  if (existsSync(path.join(bundled, "tree-sitter.wasm"))) return bundled;
  // Resolved at runtime (not by the bundler): only used when running from source.
  return path.dirname(createRequire(__filename).resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm"));
}

async function load(lang: string): Promise<Loaded | undefined> {
  const spec = LANGS[lang];
  if (!spec) return undefined;
  if (!loaded.has(lang)) {
    loaded.set(
      lang,
      (async () => {
        const dir = wasmDir();
        initPromise ??= TS.Parser.init({ locateFile: (f: string) => path.join(dir, f) });
        await initPromise;
        const language = await TS.Language.load(path.join(dir, spec.wasm));
        const parser = new TS.Parser();
        parser.setLanguage(language);
        // Compile patterns one by one: a pattern a grammar version doesn't support is skipped, not fatal.
        const defs = spec.defs.flatMap((src) => {
          try {
            return [new TS.Query(language, src)];
          } catch {
            return [];
          }
        });
        return { language, parser, defs, refs: new Set(spec.refs) };
      })().catch(() => undefined),
    );
  }
  return loaded.get(lang)!;
}

export interface SymbolDef {
  name: string;
  /** First line of the definition, trimmed: the signature shown in the repo map. */
  signature: string;
  line: number; // 1-based
  endLine: number; // 1-based, inclusive
  /** Number of enclosing definitions (for indentation). */
  depth: number;
}

export interface FileSymbols {
  defs: SymbolDef[];
  /** Identifier → occurrence count. */
  refs: Map<string, number>;
}

const cache = new Map<string, { hash: number; symbols: FileSymbols }>();

/** Definitions and references of a file; cached by content hash, so only changed files are re-parsed. */
export async function fileSymbols(file: string, text: string): Promise<FileSymbols | undefined> {
  const lang = languageFor(file);
  if (!lang) return undefined;
  const hash = fnv1a(text);
  const hit = cache.get(file);
  if (hit && hit.hash === hash) return hit.symbols;
  const l = await load(lang);
  if (!l) return undefined;
  const tree = l.parser.parse(text);
  if (!tree) return undefined;
  try {
    const defNodes: { node: TSNode; name: string }[] = [];
    for (const q of l.defs) {
      for (const m of q.matches(tree.rootNode)) {
        const def = m.captures.find((c) => c.name === "def")?.node;
        const name = m.captures.find((c) => c.name === "name")?.node;
        if (def && name) defNodes.push({ node: def, name: name.text });
      }
    }
    defNodes.sort((a, b) => a.node.startIndex - b.node.startIndex);
    const defs = defNodes.map(({ node, name }) => ({
      name,
      signature: signatureOf(node.text),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      depth: defNodes.filter((o) => o.node.startIndex < node.startIndex && o.node.endIndex >= node.endIndex).length,
    }));
    const refs = new Map<string, number>();
    for (const n of tree.rootNode.descendantsOfType([...l.refs])) {
      if (!n) continue;
      const t = n.text;
      if (t.length > 1) refs.set(t, (refs.get(t) ?? 0) + 1);
    }
    const symbols = { defs, refs };
    cache.set(file, { hash, symbols });
    return symbols;
  } finally {
    tree.delete();
  }
}

export interface Occurrence {
  line: number; // 1-based
  column: number; // 0-based, UTF-16
  start: number; // string index
  end: number;
}

/** Shorthand `{ name }` in object literals and destructuring: a reference too, for renames. */
const SHORTHAND = ["shorthand_property_identifier", "shorthand_property_identifier_pattern"];

/**
 * Identifier tokens equal to `name` (not inside strings or comments), for renames and
 * references without a language server. undefined when the language has no grammar.
 */
export async function identifierOccurrences(file: string, text: string, name: string): Promise<Occurrence[] | undefined> {
  const lang = languageFor(file);
  if (!lang) return undefined;
  const l = await load(lang);
  if (!l) return undefined;
  if (!text.includes(name)) return [];
  const tree = l.parser.parse(text);
  if (!tree) return undefined;
  try {
    const out: Occurrence[] = [];
    for (const n of tree.rootNode.descendantsOfType([...l.refs, ...SHORTHAND])) {
      if (n && n.text === name) out.push({ line: n.startPosition.row + 1, column: n.startPosition.column, start: n.startIndex, end: n.endIndex });
    }
    // The WASM parser reads JS strings as UTF-16, so indexes are string indexes already.
    return out.sort((a, b) => a.start - b.start);
  } finally {
    tree.delete();
  }
}

export type SyntaxNode = TSNode;

/** `fn` applied to the syntax tree of `text` (freed afterwards); undefined when the language has no grammar. */
export async function withTree<T>(file: string, text: string, fn: (root: SyntaxNode) => T): Promise<T | undefined> {
  const lang = languageFor(file);
  if (!lang) return undefined;
  const l = await load(lang);
  if (!l) return undefined;
  const tree = l.parser.parse(text);
  if (!tree) return undefined;
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}

const COMMENTS = ["comment", "line_comment", "block_comment"];

/**
 * `text` without its comments, trailing spaces and empty lines (indentation kept: it is code in
 * Python): two versions that differ only in comments give the same result.
 */
export async function codeWithoutComments(file: string, text: string): Promise<string | undefined> {
  return withTree(file, text, (root) => {
    let out = text;
    const nodes = root.descendantsOfType(COMMENTS).filter((n): n is SyntaxNode => !!n);
    for (const n of nodes.sort((a, b) => b.startIndex - a.startIndex)) out = out.slice(0, n.startIndex) + out.slice(n.endIndex);
    return out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).join("\n");
  });
}

/** Whole-word occurrences of `name` inside comments; undefined when the language has no grammar. */
export async function commentOccurrences(file: string, text: string, name: string): Promise<Occurrence[] | undefined> {
  const lang = languageFor(file);
  if (!lang) return undefined;
  const l = await load(lang);
  if (!l) return undefined;
  if (!text.includes(name)) return [];
  const tree = l.parser.parse(text);
  if (!tree) return undefined;
  try {
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const out: Occurrence[] = [];
    for (const n of tree.rootNode.descendantsOfType(COMMENTS)) {
      if (!n) continue;
      for (const m of n.text.matchAll(word)) {
        const start = n.startIndex + m.index!;
        const before = text.slice(0, start);
        out.push({ line: before.split("\n").length, column: start - before.lastIndexOf("\n") - 1, start, end: start + name.length });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  } finally {
    tree.delete();
  }
}

/**
 * First syntax error in `text` ("line N: ..."), or undefined when it parses
 * cleanly or the language has no grammar.
 */
export async function syntaxError(file: string, text: string): Promise<string | undefined | null> {
  const lang = languageFor(file);
  if (!lang) return null; // null: unknown language, caller should fall back
  const l = await load(lang);
  if (!l) return null;
  const tree = l.parser.parse(text);
  if (!tree) return null;
  try {
    if (!tree.rootNode.hasError) return undefined;
    const bad = findErrorNode(tree.rootNode);
    if (!bad) return "syntax error";
    const line = bad.startPosition.row + 1;
    const src = text.split("\n")[line - 1]?.trim() ?? "";
    return bad.isMissing ? `line ${line}: missing \`${bad.type}\` near \`${src}\`` : `line ${line}: unexpected code \`${src.slice(0, 80)}\``;
  } finally {
    tree.delete();
  }
}

function findErrorNode(node: TSNode): TSNode | undefined {
  if (node.isError || node.isMissing) return node;
  for (const child of node.children) {
    if (child && (child.hasError || child.isMissing)) {
      const found = findErrorNode(child);
      if (found) return found;
    }
  }
  return undefined;
}

function signatureOf(text: string): string {
  const first = text.split("\n")[0].trim().replace(/\s*[{:]?\s*$/, "").replace(/\s*=>\s*$/, " =>");
  return first.length > 120 ? first.slice(0, 117) + "..." : first;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
