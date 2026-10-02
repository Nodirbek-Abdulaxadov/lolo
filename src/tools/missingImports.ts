import type { FileChange } from "../host/types";
import { detectEol } from "../edit/text";

/**
 * Missing `using` directives, added by code like an IDE quick fix. A build that fails with
 * "The name 'Regex' does not exist in the current context" is trivial to fix, but a 7B
 * model adding the line tends to replace a method signature with a second copy of the
 * class, and then gets stuck. Only well-known framework types (no NuGet packages).
 */
const CS_NAMESPACES: Record<string, string> = {};
const add = (ns: string, names: string) => names.split(" ").forEach((n) => (CS_NAMESPACES[n] = ns));
add("System.Text.RegularExpressions", "Regex RegexOptions Match MatchCollection Group");
add("System.Text", "StringBuilder Encoding");
add("System.Text.Json", "JsonSerializer JsonSerializerOptions JsonDocument JsonElement JsonException JsonNamingPolicy");
add("System.Text.Json.Serialization", "JsonPropertyName JsonIgnore JsonConverter JsonStringEnumConverter");
add("System.Globalization", "CultureInfo NumberStyles DateTimeStyles");
add("System.Diagnostics", "Stopwatch Debug Process Trace");
// Nullability attributes models add to Equals/TryGet overrides after a CS8765 warning.
add("System.Diagnostics.CodeAnalysis", "NotNullWhen NotNullWhenAttribute MaybeNullWhen MaybeNullWhenAttribute NotNull MaybeNull AllowNull DisallowNull MemberNotNull MemberNotNullWhen DoesNotReturn SetsRequiredMembers ExcludeFromCodeCoverage");
add("System.Runtime.CompilerServices", "CallerMemberName CallerFilePath CallerLineNumber");
add("System.Collections.Concurrent", "ConcurrentDictionary ConcurrentQueue ConcurrentBag ConcurrentStack BlockingCollection");
add("System.Collections.Immutable", "ImmutableArray ImmutableList ImmutableDictionary ImmutableHashSet");
add("System.Collections.ObjectModel", "ObservableCollection ReadOnlyCollection ReadOnlyDictionary Collection");
add("System.Collections.Generic", "List Dictionary HashSet Queue Stack SortedDictionary SortedSet LinkedList KeyValuePair IEnumerable IList IDictionary IReadOnlyList IReadOnlyDictionary IReadOnlyCollection ICollection IComparer IEqualityComparer");
add("System.Linq", "Enumerable IGrouping ILookup IOrderedEnumerable");
add("System.IO", "File Path Directory FileInfo DirectoryInfo Stream StreamReader StreamWriter MemoryStream FileStream TextReader TextWriter StringReader StringWriter IOException FileNotFoundException");
add("System.Threading", "CancellationToken CancellationTokenSource Interlocked SemaphoreSlim Mutex Monitor Thread Timer");
add("System.Threading.Tasks", "Task ValueTask Parallel TaskCompletionSource");
add("System.Threading.Channels", "Channel ChannelReader ChannelWriter");
add("System.Security.Cryptography", "SHA256 SHA1 SHA512 MD5 RandomNumberGenerator HMACSHA256 Aes");
add("System.Numerics", "BigInteger Complex Vector2 Vector3");
add("System.ComponentModel.DataAnnotations", "Required Range StringLength MaxLength MinLength EmailAddress RegularExpression Key");
add("System.Net", "IPAddress Dns HttpStatusCode WebUtility");
add("System.Net.Http", "HttpClient HttpResponseMessage HttpRequestMessage HttpMethod");
add("System.Xml.Linq", "XDocument XElement XAttribute");

/** `file(line,col): error CS0103: The name 'Regex' does not exist ...` / `error CS0246: The type or namespace name 'List<>' could not be found`. */
const CS_ERROR = /^\s*(.+?\.cs)\(\d+,\d+\): error CS(?:0103|0246): The (?:type or namespace )?name '([A-Za-z_]\w*)(?:<[^']*>)?'/gm;

/** Workspace-relative POSIX path, or undefined when `file` is outside `root`. */
export function workspacePath(file: string, root: string): string | undefined {
  const f = file.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  const abs = /^([a-zA-Z]:)?\//.test(f);
  if (!abs) return f.replace(/^\.\//, "");
  const insensitive = /^[a-zA-Z]:/.test(r);
  const prefix = r + "/";
  const matches = insensitive ? f.toLowerCase().startsWith(prefix.toLowerCase()) : f.startsWith(prefix);
  return matches ? f.slice(prefix.length) : undefined;
}

/** `content` with `using <ns>;` after its last using directive, or at the top. */
export function addUsing(content: string, ns: string): string {
  const eol = detectEol(content);
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const lines = content.slice(bom.length).split(/\r?\n/);
  const using = /^\s*(global\s+)?using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>]+)?\s*;/;
  if (lines.some((l) => new RegExp(`^\\s*(global\\s+)?using\\s+${ns.replace(/\./g, "\\.")}\\s*;`).test(l))) return content;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (using.test(lines[i])) last = i;
    else if (lines[i].trim() && !/^\s*(\/\/|#)/.test(lines[i])) break; // first code line: usings come before it
  }
  if (last >= 0) lines.splice(last + 1, 0, `using ${ns};`);
  else lines.splice(0, 0, `using ${ns};`, ...(lines[0]?.trim() ? [""] : []));
  return bom + lines.join(eol);
}

const CS_NAMESPACE = /^\s*namespace\s+([\w.]+)\s*[;{]?/m;
const CS_TYPE = /\b(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/g;

/** Types the project's own C# files declare → their namespace (files without a namespace are left out). */
export async function projectTypes(files: string[], read: (path: string) => Promise<string>): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  for (const f of files.filter((f) => /\.cs$/i.test(f) && !/(^|\/)(bin|obj)\//.test(f)).slice(0, 300)) {
    const text = await read(f).catch(() => "");
    const ns = CS_NAMESPACE.exec(text)?.[1];
    if (ns) for (const m of text.matchAll(CS_TYPE)) if (!types.has(m[1])) types.set(m[1], ns);
  }
  return types;
}

/** Namespace names models write when they don't know the project's: `YourNamespace`, `MyNamespace`, `Example`. */
const PLACEHOLDER_NAMESPACE = /^(Your\w*|My(Namespace|Project|Company)\w*|Namespace\d*|Example\w*|Sample\w*)$/;

/**
 * A new C# file in a placeholder namespace (`namespace YourNamespace`) that no other file uses, in a
 * project whose files share one namespace: the file with the project's namespace instead (else
 * undefined). Otherwise its types are invisible to the rest of the project (CS0246).
 */
export function placeholderNamespaceFix(content: string, otherFiles: string[]): { content: string; from: string; to: string } | undefined {
  const m = CS_NAMESPACE.exec(content);
  if (!m || !PLACEHOLDER_NAMESPACE.test(m[1])) return undefined;
  const used = new Set(otherFiles.map((t) => CS_NAMESPACE.exec(t)?.[1]).filter((n): n is string => !!n));
  if (used.size !== 1 || used.has(m[1])) return undefined;
  const to = [...used][0];
  return { content: content.slice(0, m.index) + m[0].replace(m[1], to) + content.slice(m.index + m[0].length), from: m[1], to };
}

/**
 * Fixes for C# build output: the missing using directives per file, as new file contents,
 * and a note for the model. Empty when the output has none of the known types. `types` lists
 * the project's own types (loaded only when a name isn't a well-known framework type): a type
 * declared in another namespace of the project gets its `using` like an IDE quick fix.
 */
export async function missingUsings(
  output: string,
  root: string,
  read: (path: string) => Promise<string>,
  types?: () => Promise<Map<string, string>>,
): Promise<{ changes: FileChange[]; note: string }> {
  const wanted = new Map<string, Set<string>>();
  let project: Map<string, string> | undefined;
  for (const m of output.matchAll(CS_ERROR)) {
    const file = workspacePath(m[1].trim(), root);
    if (!file) continue;
    let ns = CS_NAMESPACES[m[2]];
    if (!ns && types) ns = (project ??= await types()).get(m[2]) as string;
    if (!ns) continue;
    wanted.set(file, (wanted.get(file) ?? new Set()).add(ns));
  }
  const changes: FileChange[] = [];
  const notes: string[] = [];
  for (const [file, namespaces] of wanted) {
    const before = await read(file).catch(() => undefined);
    if (before === undefined) continue;
    let after = before;
    for (const ns of namespaces) after = addUsing(after, ns);
    if (after === before) continue;
    changes.push({ path: file, content: after });
    notes.push(`${[...namespaces].map((n) => `\`using ${n};\``).join(", ")} to ${file}`);
  }
  return { changes, note: notes.length ? `Added the missing ${notes.join("; ")}.` : "" };
}
