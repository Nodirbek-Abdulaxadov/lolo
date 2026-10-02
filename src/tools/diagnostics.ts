import type { Diagnostic } from "../host/types";
import { ok, ToolDef } from "./types";

export function formatDiagnostics(diags: Diagnostic[], max = 40): string {
  const sorted = [...diags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  const lines = sorted.slice(0, max).map((d) => `${d.path}:${d.line}: ${d.severity}: ${d.message}`);
  if (sorted.length > max) lines.push(`[${sorted.length - max} more]`);
  return lines.join("\n");
}

export const getDiagnostics: ToolDef<{ path?: string }> = {
  name: "get_diagnostics",
  kind: "read",
  // Rarely called (0.3% of calls in the eval): new errors are reported after every write anyway.
  group: "diagnostics",
  description: "Compiler/linter errors and warnings, for one file or the whole workspace.",
  params: { type: "object", properties: { path: { type: "string" } } },
  async run(a, ctx) {
    const diags = await ctx.host.diagnostics(a.path ? [a.path] : undefined);
    const errors = diags.filter((d) => d.severity === "error").length;
    if (!diags.length) return ok("No problems found.", `get_diagnostics ${a.path ?? "workspace"}: clean`);
    return ok(formatDiagnostics(diags), `get_diagnostics ${a.path ?? "workspace"}: ${errors} errors, ${diags.length - errors} warnings`);
  },
};
