import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { claudePermissions, listSkills, loadInstructions, parseSkill, skillBlock, skillMentioned, skillsFor } from "../src/context/claudeSetup";
import { expandSlashCommand, listSlashCommands } from "../src/context/slashCommands";
import { NodeHost } from "../src/host/nodeHost";
import { loadMcpConfig } from "../src/mcp/hub";
import { decideCommand } from "../src/tools/commandPolicy";

const TRACKER = `---
name: issue-tracker
description: |
  Track work in Jira via REST API. TRIGGER on fix/add commands.
  SKIP for questions.
triggers:
  - fix
---

# Issue tracker
Load credentials from .env, then run curl against $JIRA_BASE_URL.
`;
const SQUASH = "---\nname: migration-squash\ndescription: Squash accumulated EF Core migrations into one baseline.\n---\nSteps...";

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-claude-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  return { root, host: new NodeHost(root) };
}

describe("Claude Code setups", () => {
  it("reads CLAUDE.md and AGENTS.md once each, with @imports", async () => {
    const { host } = workspace({ "CLAUDE.md": "# Rules\nUse MudBlazor.\n@docs/style.md\n", "AGENTS.md": "# Rules\nUse MudBlazor.\n@docs/style.md\n", "docs/style.md": "Tabs, not spaces." });
    const r = await loadInstructions(host);
    expect(r.sources).toEqual(["CLAUDE.md"]);
    expect(r.text).toBe("# Rules\nUse MudBlazor.\nTabs, not spaces.");
  });

  it("parses skills, including block descriptions", () => {
    const s = parseSkill(TRACKER, "x", ".claude/skills/issue-tracker/SKILL.md");
    expect(s.name).toBe("issue-tracker");
    expect(s.summary).toBe("Track work in Jira via REST API.");
    expect(s.body).toContain("Load credentials from .env");
  });

  it("loads a skill when the message asks for it, not for common words", async () => {
    const { host } = workspace({ ".claude/skills/issue-tracker/SKILL.md": TRACKER, ".claude/skills/migration-squash/SKILL.md": SQUASH });
    const skills = await listSkills(host, "/nonexistent");
    expect(skills.map((s) => s.name)).toEqual(["issue-tracker", "migration-squash"]);
    const jiraSkill = parseSkill(TRACKER.replace("name: issue-tracker", "name: jira-task-tracker"), "x", "p");
    expect(skillMentioned("Create Jira issue via the tracker", jiraSkill)).toBe(true);
    expect(skillMentioned("Fix the binding error in Form.razor", jiraSkill)).toBe(false);
    const names = (m: string) => skillsFor(m, skills).map((s) => s.name);
    expect(names("jira skill orqali jira task ochishing kerak edi")).toEqual(["issue-tracker"]);
    expect(names("Create a JIRA ticket for this bug")).toEqual([]); // no "skill", and "jira" isn't in the name
    const jira = parseSkill(TRACKER.replace("name: issue-tracker", "name: jira-task-tracker"), "x", "p");
    expect(skillsFor("Create a JIRA ticket for this bug", [jira])).toHaveLength(1);
    expect(names("use the migration skill")).toEqual(["migration-squash"]);
    expect(names("/migration-squash now")).toEqual(["migration-squash"]);
    expect(names("add a migration for the new column")).toEqual([]);
    expect(names("fix the null check in Form.razor")).toEqual([]);
    expect(skillBlock(skills[0])).toContain("python3 - <<'EOF'");
    expect((await listSkills(host, null)).map((s) => s.name)).toEqual(["issue-tracker", "migration-squash"]);
  });

  it("takes the later word of a product name ('Claude Code') only with the words before it", () => {
    const guard = parseSkill("---\nname: commit-guard-claude-code\ndescription: Set up Claude Code hooks that block risky commits. Use when the user wants commit checks in Claude Code.\n---\nSteps...", "x", "p");
    expect(skillsFor("The parser crashes on empty input; fix the code in lib/", [guard])).toEqual([]);
    expect(skillMentioned("Update the code in lib/parse.js", guard)).toBe(false);
    expect(skillsFor("add the commit hooks to claude code", [guard])).toHaveLength(1);
    expect(skillsFor("claude code skill bilan commitlarni tekshir", [guard])).toHaveLength(1);
    // After a comma, still a product: "Jira, Confluence".
    const wiki = parseSkill("---\nname: confluence-pages\ndescription: Keep notes in sync with Jira, Confluence and Slack.\n---\nSteps...", "x", "p");
    expect(skillsFor("put this into the confluence page", [wiki])).toHaveLength(1);
    // "skill" in a skill's name doesn't match every message that says "skill".
    const writer = parseSkill("---\nname: write-a-skill\ndescription: Create new agent skills.\n---\nSteps...", "x", "p");
    expect(skillsFor("confluence skill orqali sahifa och", [wiki, writer]).map((s) => s.name)).toEqual(["confluence-pages"]);
    expect(skillsFor("/write-a-skill for releases", [writer])).toHaveLength(1);
  });

  it("turns Bash(...) permissions into the command allowlist and denylist", async () => {
    const { host } = workspace({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(dotnet build:*)", "Skill(x)"], deny: ["Bash(git push:*)"] } }),
      ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(rtk dotnet *)", "Bash(*)"] } }),
    });
    const p = await claudePermissions(host);
    expect(p.allow).toEqual(["dotnet build", "rtk dotnet", "*"]);
    expect(p.deny).toEqual(["git push"]);
    expect(decideCommand("curl -s https://jira.example.com", p.allow, p.deny).kind).toBe("allow");
    expect(decideCommand("git push origin main", p.allow, p.deny).kind).toBe("block");
    expect(decideCommand("rm -rf /", p.allow, p.deny).kind).toBe("block");
  });

  it("offers .claude/commands and skills as slash commands, and reads .mcp.json", async () => {
    const { root, host } = workspace({
      ".claude/commands/review.md": "---\ndescription: Review a file\n---\nReview $ARGUMENTS.",
      ".claude/skills/issue-tracker/SKILL.md": TRACKER,
      ".mcp.json": JSON.stringify({ mcpServers: { figma: { command: "npx", args: ["figma-mcp"] }, off: { command: "x" } } }),
      ".claude/settings.local.json": JSON.stringify({ disabledMcpjsonServers: ["off"] }),
    });
    const names = (await listSlashCommands(host)).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["review", "issue-tracker"]));
    expect(await expandSlashCommand("/review Form.razor", host)).toBe("Review Form.razor.");
    expect(await expandSlashCommand("/issue-tracker open a task for the save bug", host)).toBe("Use the issue-tracker skill. open a task for the save bug");
    expect(Object.keys(loadMcpConfig(root))).toEqual(["figma"]);
  });
});

describe("plans for skills", () => {
  it("keeps 'open a Jira issue' and drops todos that only ask the user", async () => {
    const { dropLookOnlyTodos } = await import("../src/agent/planner");
    expect(dropLookOnlyTodos(["Determine task scope (1-2 files)", "Ask user if Jira should be opened for this small task", "Open a Jira issue for the save error"], "g")).toEqual(["Open a Jira issue for the save error"]);
    expect(dropLookOnlyTodos(["Open src/Form.razor", "Fix the binding in src/Form.razor"], "g")).toEqual(["Fix the binding in src/Form.razor"]);
  });
});

describe("API calls from skills", () => {
  it("refuses variables that single quotes would send literally", async () => {
    const { unexpandedVariables } = await import("../src/tools/runCommand");
    expect(unexpandedVariables(`curl -X POST "$JIRA_BASE_URL/rest" --data-binary '{"project":{"key":"$JIRA_PROJECT_KEY"},"d":"$(date +%F)"}'`)).toEqual(["$JIRA_PROJECT_KEY", "$(date +%F)"]);
    expect(unexpandedVariables(`curl -H "Authorization: Bearer $JIRA_PAT" "$JIRA_BASE_URL/x" | jq -r '.issueTypes[] | .id'`)).toEqual([]);
    expect(unexpandedVariables(`awk '{print $1, $NF}' f.txt`)).toEqual([]);
    expect(unexpandedVariables(`jq --arg n "$X" '.[] | select(.name == $n)'`)).toEqual([]);
    expect(unexpandedVariables(`bash -c 'echo $(date) $HOME_DIR'`)).toEqual([]);
    expect(unexpandedVariables(`python3 - <<'EOF'\nprint('$NOT_SHELL')\nEOF`)).toEqual([]);
    expect(unexpandedVariables(`echo "don't" '$HOME_DIR'`)).toEqual(["$HOME_DIR"]);
  });

  it("shows .env variable names, never their values", async () => {
    const { isSecretsFile, maskSecrets } = await import("../src/tools/fileTools");
    expect(isSecretsFile(".env")).toBe(true);
    expect(isSecretsFile("config/.env.local")).toBe(true);
    expect(isSecretsFile(".env.example")).toBe(false);
    const out = maskSecrets(".env", "# jira\nJIRA_PAT=abc123secret\nJIRA_EMAIL=\nexport X='q'\n");
    expect(out).toContain("JIRA_PAT=<set, 12 chars>");
    expect(out).toContain("JIRA_EMAIL=<empty>");
    expect(out).not.toContain("abc123secret");
  });
});
