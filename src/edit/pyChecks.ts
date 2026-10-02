import { withTree, type SyntaxNode } from "../context/treeSitter";

/**
 * Python's counterpart of jsChecks' undefined names: a new reference to a name the file defines,
 * imports or assigns nowhere raises NameError only when that line runs, often in a path the tests
 * don't cover. Scope-insensitive (any binding anywhere counts), so it only flags names that exist
 * nowhere in the file. Only names the write introduces count.
 */

const BUILTINS = new Set(
  (
    "abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits delattr dict dir divmod " +
    "enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len license list " +
    "locals map max memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum " +
    "super tuple type vars zip __import__ __name__ __file__ __doc__ __package__ __spec__ __loader__ __builtins__ __path__ __debug__ __annotations__ __dict__ " +
    "self cls True False None NotImplemented Ellipsis _ WindowsError get_ipython display reveal_type " +
    "BaseException BaseExceptionGroup Exception ExceptionGroup ArithmeticError AssertionError AttributeError BlockingIOError BrokenPipeError BufferError " +
    "ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError EOFError EnvironmentError FileExistsError " +
    "FileNotFoundError FloatingPointError GeneratorExit IOError ImportError IndentationError IndexError InterruptedError IsADirectoryError KeyError " +
    "KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError NotADirectoryError NotImplementedError OSError OverflowError PermissionError " +
    "ProcessLookupError RecursionError ReferenceError RuntimeError StopAsyncIteration StopIteration SyntaxError SystemError SystemExit TabError TimeoutError " +
    "TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError ValueError ZeroDivisionError EncodingWarning " +
    "Warning UserWarning DeprecationWarning PendingDeprecationWarning SyntaxWarning RuntimeWarning FutureWarning ImportWarning UnicodeWarning BytesWarning ResourceWarning"
  ).split(" "),
);

/** Files where names can come from elsewhere: star imports, exec, globals() tricks. */
const DYNAMIC = /^\s*from\s+\S+\s+import\s+\*|\bexec\s*\(|\b(globals|locals|vars)\s*\(\s*\)\s*(\[|\.update\b)|\b__builtins__\b|\bsetattr\s*\(\s*(sys\.modules|builtins)/m;

const field = (n: SyntaxNode, name: string) => n.childForFieldName(name);
const same = (a: SyntaxNode | null | undefined, b: SyntaxNode) => !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex;

/** Identifiers a target (`x`, `a, (b, c)`, `*rest`) binds; attributes and subscripts bind nothing. */
function targetNames(t: SyntaxNode | null): SyntaxNode[] {
  if (!t) return [];
  if (t.type === "identifier") return [t];
  if (/^(pattern_list|tuple_pattern|list_pattern|tuple|list|list_splat_pattern|dictionary_splat_pattern|parenthesized_expression|as_pattern_target|pattern)$/.test(t.type)) {
    return t.namedChildren.flatMap((c) => targetNames(c));
  }
  return [];
}

function bindings(root: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const add = (ns: SyntaxNode[]) => ns.forEach((n) => names.add(n.text));
  for (const n of root.descendantsOfType([
    "function_definition", "class_definition", "parameters", "lambda_parameters", "assignment", "augmented_assignment", "for_statement", "for_in_clause",
    "as_pattern_target", "named_expression", "global_statement", "nonlocal_statement", "import_statement", "import_from_statement", "as_pattern", "type_alias_statement",
  ])) {
    if (!n) continue;
    switch (n.type) {
      case "function_definition":
      case "class_definition":
        add([field(n, "name")].filter((x): x is SyntaxNode => !!x));
        break;
      case "parameters":
      case "lambda_parameters":
        for (const p of n.namedChildren) {
          if (!p) continue;
          if (p.type === "identifier") add([p]);
          else if (/default_parameter$/.test(p.type)) add(targetNames(field(p, "name")));
          // `x: int`, `*args: Any`, `**kw: Any`: the first child is the name (or its splat).
          else if (p.type === "typed_parameter" || /splat_pattern$/.test(p.type)) add(p.type === "typed_parameter" ? targetNames(p.namedChildren[0] ?? null) : targetNames(p));
        }
        break;
      case "assignment":
      case "augmented_assignment":
      case "for_statement":
      case "for_in_clause":
        add(targetNames(field(n, "left")));
        break;
      case "as_pattern_target":
        add(targetNames(n));
        break;
      case "named_expression":
        add(targetNames(field(n, "name")));
        break;
      case "as_pattern": // `case _ as unknown:`
        add(targetNames(field(n, "alias")));
        break;
      case "type_alias_statement": // `type Callback = ...`
        add(targetNames(n.namedChildren[0]?.namedChildren[0] ?? n.namedChildren[0] ?? null));
        break;
      case "global_statement":
      case "nonlocal_statement":
        add(n.namedChildren.filter((c): c is SyntaxNode => !!c && c.type === "identifier"));
        break;
      case "import_statement":
      case "import_from_statement":
        for (const c of n.namedChildren) {
          if (!c || (n.type === "import_from_statement" && same(field(n, "module_name"), c))) continue;
          if (c.type === "aliased_import") add([field(c, "alias")].filter((x): x is SyntaxNode => !!x));
          // `import os.path` binds `os`; `from a import b` binds `b`.
          else if (c.type === "dotted_name") add(c.namedChildren.filter((x): x is SyntaxNode => !!x).slice(n.type === "import_statement" ? 0 : -1).slice(0, 1));
        }
        break;
    }
  }
  return names;
}

/** An identifier used as a value: not an attribute name, a keyword argument's name or part of an import path. */
function isReference(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  if (p.type === "attribute") return !same(field(p, "attribute"), n);
  if (p.type === "keyword_argument") return !same(field(p, "name"), n);
  return !/^(dotted_name|aliased_import|global_statement|nonlocal_statement)$/.test(p.type);
}

interface Undefined {
  name: string;
  line: number;
}

function undefinedNames(root: SyntaxNode, text: string): Undefined[] {
  if (DYNAMIC.test(text)) return [];
  const bound = bindings(root);
  const out: Undefined[] = [];
  for (const n of root.descendantsOfType(["identifier"])) {
    if (!n || bound.has(n.text) || BUILTINS.has(n.text) || /^__\w+__$/.test(n.text) || out.some((u) => u.name === n.text) || !isReference(n)) continue;
    out.push({ name: n.text, line: n.startPosition.row + 1 });
  }
  return out;
}

/** Advice for a NameError the write would introduce in a Python file, else undefined. */
export async function pyRuntimeProblem(path: string, before: string | undefined, after: string): Promise<string | undefined> {
  if (!/\.pyw?$/.test(path)) return undefined;
  const found = await withTree(path, after, (root) => (root.hasError ? undefined : undefinedNames(root, after)));
  if (!found?.length) return undefined;
  const had = before === undefined ? [] : ((await withTree(path, before, (root) => undefinedNames(root, before).map((u) => u.name))) ?? []);
  const undef = found.find((u) => !had.includes(u.name));
  if (!undef) return undefined;
  const line = after.replace(/\r\n/g, "\n").split("\n")[undef.line - 1]?.trim().slice(0, 120) ?? "";
  return (
    `\`${undef.name}\` is not defined in ${path} (line ${undef.line}: \`${line}\`): it isn't imported, assigned or a parameter anywhere in the file, ` +
    `so this line would raise NameError. Use a name that exists there, or import or define \`${undef.name}\` first. The file was NOT changed.`
  );
}
