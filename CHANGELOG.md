# Changelog

## Unreleased

Fixes for every failure of the 0.5.0 evaluation, done by code:

- `node --test` failures are understood (its output without a terminal is TAP), and failing tests show the line of the assertion. Python's shared mutable default arguments are pointed out.
- JavaScript that would throw at runtime is refused: a variable declared twice, `const tax = tax(a)`, undefined names, an export whose shape breaks another file's import.
- More edit repairs: a whole function or block replaced when only its first line was quoted (also with `edit_lines`), re-typed lines not left behind, a line range one line short, regex escapes lost in JSON, C# regex escapes (CS1009), missing `using` for the project's own types, placeholder namespaces.
- No tests the user didn't ask for; no "move" done by hand instead of move_file; no reverting a change the user asked to keep; comment-only "fixes" and redone changes are no-ops.
- Runaway replies that repeat a block of code are stopped early.
- Skills: a word of a skill's name that the description uses only inside a longer name ("Code" in "Claude Code") no longer loads the skill on its own, so "fix the code" doesn't pull in a Claude Code hooks skill. "skill" in a skill's name doesn't match every message that says "skill". The eval no longer reads `~/.claude/skills`.
- A second import of a name is refused with the line of the existing import ("change that line"); models renamed the new import instead.
- Copied regexes: `[+]` written for `\+` is restored with the rest of the line.
- A todo that runs out of steps is complete when its changes pass the checks, as when it gets stuck.
- A write that adds an import the file never uses says so ("imports `dataclass` but doesn't use it anywhere yet").

Evaluation, 38 tasks × 2 runs, RTX 4070 Ti (Windows 11):

| | qwen2.5-coder:7b | qwen3.5:9b | target |
|---|---|---|---|
| tool-call validity | 98.7% → 98.7% | 99.8% → 99.4% | ≥ 98% |
| edit apply | 89.6% → 95.5% | 95.8% → 99.0% | ≥ 95% |
| task pass | 78.9% → 89.5% | 93.4% → 96.1% | ≥ 60% |

qwen2.5-coder:7b now meets all three targets of the plan (task pass over three runs: 90.8%, 88.2%, 89.5%). It still fails `go-chunk` (it decides the loop is already right) and often `git-fix-uncommitted` (arithmetic).

**Fine-tune, retrained** on 4,059 samples from the passing runs (the same 12 tasks held out as before; the first `lolo-coder` had 2,044). On the 12 held-out tasks, 4 runs each, all with this orchestration:

| | qwen2.5-coder:7b | lolo-coder (first) | lolo-coder (new) |
|---|---|---|---|
| task pass | 79.2% | 72.9% | 83.3% |
| edit apply | 87.9% | 94.3% | 91.2% |
| tool-call validity | 99.4% | 99.4% | 98.6% |

The new model passes 2 more of the 48 held-out runs than the base model and 5 more than the first fine-tune: a small gain next to what orchestration gave the base model on the same tasks (72.9% → 79.2%).

## 0.6.0

- **Claude Code hooks.** `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop` hooks from `.claude/settings.json`, `.claude/settings.local.json` and `~/.claude/settings.json` run with Claude Code's contract (JSON on stdin, exit 2 blocks, `decision`/`permissionDecision`/`additionalContext` output) and tool names (`Bash`, `Edit|Write`, `mcp__…`). A PostToolUse hook that runs the tests after `dotnet build` now reports failures to the model; a Stop hook's block adds a todo. Trusted workspaces only; `localAgent.claudeHooks` / `--no-hooks` turn them off.

## 0.5.5

- `npm install vue@3 vite@5` and `npm create vite@latest` were taken for servers (the word "vite") and run in the background, where they failed with 127 and a finished install counted as a failure. Only `vite`/`npx vite` itself starts a dev server now.
- Node installed with nvm (or volta, fnm, asdf) is found when VS Code's PATH has no `node`: commands started in the background got "npm: command not found".
- `cd frontend-v2 && npm install` with `cwd: frontend-v2` runs from the root instead of failing on the second `cd`.
- Files a command generated in this run (vite's `App.vue`, `main.ts`) can be replaced with `create_file` or `rewrite_file` without reading them first; the model lost steps to "already exists" and "read it first".
- While writes keep applying, a todo may take up to 3× `maxStepsPerTodo` steps (was 2×): migrating a whole folder needs more than 30.

## 0.5.4

- A long request without "?" is no longer taken for a question because a question word appears in it: "Qayerda sodir etilganligi" was one of the Excel column names in the request, and the agent only read files until it ran out of steps.
- Uzbek in Cyrillic: request words (ўзгартир, алмаштир, тузат, қўш, кирит, ...) count as a request.
- Questions: two steps before the limit only `answer` is offered, so a long search ends with an answer from what was read instead of "no result after 15 steps".

## 0.5.3

- Skills that call an API are run as short Python scripts (`python3 - <<'EOF'`): the script reads `.env`, builds JSON with `json.dumps` and fails on HTTP errors. With curl, a 9B model put `$JIRA_PROJECT_KEY` inside single quotes (sent literally) and read exit code 0 of a failed request as success.
- `run_command` refuses variables and `$(...)` inside single quotes, which the shell would send literally, and says how to fix it.
- `read_file` of `.env` shows the variable names only; the values (tokens) no longer reach the model or the run logs.
- Chat: a tool row whose command contains `: ` (e.g. `-H "Authorization: Bearer …"`) showed a piece of the command instead of its result.

## 0.5.2

- **Claude Code setups work as is.** `CLAUDE.md` / `AGENTS.md` (with `@file` imports) are project instructions in every prompt; skills in `.claude/skills` (and `.agent/skills`, `~/.claude/skills`) are listed, and a skill's instructions are added when the message asks for it (`/skill-name`, its name, "… skill"); `.claude/commands` are slash commands; `.mcp.json` servers are started; `Bash(...)` permissions from `.claude/settings.json` extend the command allowlist (`deny` rules are refused). Before, "create a Jira task with the jira skill" got "I have no Jira tool".
- A skill the user asked for but the plan ignores becomes the first todo (qwen2.5-coder planned only the bug fix), and the task line names the skill to use.
- Uzbek: "och" (open, e.g. a task) and "orqali" (via) get English hints, and "och" counts as a request.
- A skill the user asked for counts as confirmed: its "ask before doing it" step is skipped (the model ended every run with "Jira ochaymi?"), and plan todos that only ask the user are dropped.
- Plans: "Open a Jira issue" is no longer dropped as a look-only todo ("open" counts as looking only for files).
- A short follow-up ("och", "open it") keeps the skill of the request before it; without it the model looked for a `jira-task-tracker` dotnet tool.

## 0.5.0

Stage 14 of the plan: Windows, a much larger evaluation, and the agent fixes it found.

**Windows.** Tested on Windows 11 (unit tests, the VS Code smoke test and the evaluation); CI now runs the tests and the smoke test on Linux, Windows and macOS.

- Commands run in Git Bash (installed with Git), so the `ls`, `grep`, `&&` and `test -f` that models write work; the agent's VS Code terminal is Git Bash too. Without Git Bash, cmd.exe, and the prompt says so.
- `python3` works when Windows only has the Microsoft Store placeholder for it.
- Background servers (`npm run dev`) are really stopped at the end of a task, and commands that time out are stopped with everything they started.
- Search results and build errors show workspace-relative paths with `/`.

**Fewer failed tasks with small models.** Each fix comes from a failing run of qwen2.5-coder:7b and is done by code:

- Edits: an ambiguous `search` uses the match in the function the task names (and `all=true` stays inside it); a `replace` that repeats the lines around `search`, or is a complete new version of the function, replaces instead of duplicating; line breaks escaped twice are repaired; placeholders like `// existing implementation` and bodies left out (`{ ... }`, `// validation logic here`) are refused unless the todo asks for stubs; an edit already in place is not applied again; `rewrite_file` of a file that doesn't exist yet creates it. A file must be read before it is edited, as in Claude Code.
- JavaScript: `export`/`import` written into a CommonJS project is turned into `module.exports`/`require` by code (other forms, and `require` in a `"type": "module"` project, are refused with the form the project uses). Models wrote "exported from" as ESM, Node failed, and they converted the whole project. A file that exports a name it doesn't define is refused.
- Regexes survive JSON: JSON has no `\s`/`\d`/`\w` escapes, so under constrained decoding a copied `[^\s@]` came out as a line break (or `\ `) and the syntax guard rejected the file again and again. Broken copies of lines the model read are restored.
- Moving code into a new file: the new file is refused until one of the files the code comes from was read (a tax formula written from the task's words lost its rounding).
- Builds: missing C# `using` directives for framework types are added by code; failing builds and checks show the code at the error lines; `namespace X;` followed by braces is repaired.
- Plans: todos about the same file are merged, code in the todo list is refused, "read/identify/locate" todos and test todos nobody asked for are dropped, and moving a file is one todo (a later "fix the imports" todo completes by code once move_file did it). In the middle of a refactor, checks that fail because of a later todo run again after it. "Remember that …" always saves the fact.
- Tests: when the task is to make failing tests pass, the tests can't be edited.
- `node server.js`, `python app.py` and `go run .` of a server start it in the background instead of waiting 2 minutes.
- Replies that run away (a thought that never ends, one line repeated) are stopped while streaming instead of at the 4096-token limit.

**MCP.** `/mcp` lists every server's tools as a checklist; unchecked tools are never offered.

**Models.** Built-in settings for qwen2.5, qwen3, llama3, gemma3, mistral and deepseek-coder-v2 (32k context instead of 8k), and autocomplete tokens for deepseek-coder-v2, starcoder2 and codellama.

**Evaluation: 14 → 38 tasks**, each with hidden tests and a reference solution (`eval.js validate` checks both): .NET, multi-file refactors, TypeScript, failing-test fixes, git, memory, a background server tried with curl, MCP (a mock issue tracker), web (recorded pages) and a plan-then-"ok, do it" conversation. `eval.js fim` measures autocomplete latency. The evaluation also runs nightly in CI.

Measured on an RTX 4070 Ti (Windows 11), 38 tasks × 2 runs:

| | qwen2.5-coder:7b (32k) | qwen3.5:9b | target |
|---|---|---|---|
| tool-call validity | 98.7% | 99.8% | ≥ 98% |
| calls refused by policy (read before edit/move, protected tests) | 6.0% | 1.2% | |
| edit apply | 89.6% | 95.8% | ≥ 95% |
| task pass | 78.9% | 93.4% | ≥ 60% |
| avg steps / time per task | 6.1 / 8.8 s | 6.5 / 9.4 s | |

On the same 38 tasks before these fixes, qwen2.5-coder:7b passed 60.5% (edit apply 77.8%). qwen3.5:9b meets all three targets of the plan and fails no task in both runs; with qwen2.5-coder:7b edit apply is still below 95% (most failed edits are a `search` the model got wrong), and it fails `go-chunk` (it decides the loop is already correct), `js-extract-tax`, `js-fix-failing-tests`, `py-fix-failing-tests` and `git-fix-uncommitted` in both runs. Runs vary by a few points: the full run before the last fixes gave 80.3% and 94.7%.

Autocomplete latency (`eval.js fim`, 40 completions, before the editor's 250 ms debounce): qwen2.5-coder:1.5b p50 60 ms / p90 121 ms on the GPU and p50 325 ms / p90 1.07 s on the CPU only; qwen2.5-coder:7b p50 156 ms / p90 780 ms on the GPU. The plan's goal was p50 under 500 ms on a GPU and about 1 s on a CPU with a 1.5B model.

**Fine-tuning (plan item 14), done.** `scripts/finetune` now runs end to end on Windows: 2,044 samples from successful evaluation runs (`eval.js export --exclude` held 12 tasks out; duplicates are dropped), QLoRA on qwen2.5-coder:7b for one epoch in one hour on the RTX 4070 Ti, then a Q4_K_M GGUF through llama.cpp (current Ollama imports safetensors only for MLX architectures) and `ollama create lolo-coder`. On the 12 held-out tasks, 4 runs each, same build:

| | qwen2.5-coder:7b | lolo-coder | target |
|---|---|---|---|
| tool-call validity | 99.5% | 100% | ≥ 98% |
| edit apply | 84.8% | 91.3% | ≥ 95% |
| task pass | 72.9% | 77.1% | ≥ 60% |
| avg steps / time per task | 7.9 / 8.7 s | 6.8 / 8.1 s | |

The fine-tuned model passed more held-out runs in each of the four comparisons made while this release's fixes went in (by 2 to 5 runs), with fewer steps; it reliably writes a correct email check where the base model writes a weak one. The gain is small next to what orchestration gave: the base model went from 61% to 73% on the same tasks. Two things mattered more than the training itself: the Modelfile must keep qwen2.5-coder's template (one that printed every message sent the system prompt twice, and the fine-tuned model passed 39% instead of 75%), and on Windows unsloth's attention has to avoid SDPA's grouped-query path (no FlashAttention there: 3× slower and 12 GB were not enough).

**Releases.** Pushing a `v*` tag builds the .vsix and publishes it to the Marketplace and Open VSX once their tokens are set as repository secrets.

## 0.4.1

- "Run everything" mode (`/yolo`, `localAgent.autoRunCommands`): edits and terminal commands without asking; dangerous commands stay blocked. The chosen mode now carries over to new conversations.
- `dotnet run`, `npm run dev` and other servers are no longer refused: they start in the background, and the agent can call them with `curl`.
- When the model asks for a tool that is hidden for the current task (e.g. `start_process`), it gets it instead of an error loop.
- Generated projects: `run_command` lists the files a generator created, a missing path suggests the existing file with the same name, and a second `Program.cs` (or `package.json`, ...) in the same project is refused. This fixes runs that created `src/TodoApi/Program.cs` next to the template's and never built again.
- A todo that only runs one command (e.g. "Run `dotnet new webapi -n TodoApi`") is completed as soon as that command succeeds when more todos follow, and a todo that keeps making progress without failures gets more steps.
- .NET: a project inside another project's folder (e.g. `TodoApi/TodoApi.Tests`) is diagnosed on failing builds with the fix (move it, or `<Compile Remove>`); before, the outer project failed with "Xunit could not be found" and the agent kept editing the test project. New NuGet and npm packages must come from `dotnet add package` / `npm install` instead of hand-edited versions (a guessed EF Core 9 in a .NET 10 project). Files named only `.sln` are refused.
- `run_command` with `cwd` and paths written from the workspace root (`cwd: TodoApi`, `dotnet build TodoApi/TodoApi.csproj`) runs from the root instead of failing with "file not found".
- `start_process` reports the address the server listens on, not the first URL in its log.
- Command output is cleaned of terminal control sequences and progress redraws (the MSBuild terminal logger is turned off).
- README: context size and hardware guide.

## 0.4.0

Stages 11–14 of the plan: stronger tools, web, MCP, memory. Every optional tool is offered only when a task needs it, so small models still see ≤ 10 tools per step.

- Refactoring by code: `rename_symbol` (language server in VS Code, tree-sitter elsewhere) renames definitions, imports and calls across files in one reviewed step; `find_references`, `find_definition`, `read_symbol`; `move_file`/`delete_file`; read-only `git_diff`/`git_log`/`git_blame`.
- `start_process` runs a server in the background until it is ready, so it can be tried with `curl`; everything is stopped when the task ends.
- Test output parsing for vitest/jest, node:test, pytest, unittest, dotnet test and cargo test: failures first, as `file:line name: message`.
- Rules hooks: `after-edit:` (e.g. a formatter) and `before-done:`.
- Web search (off by default): SearXNG, Brave, Tavily or DuckDuckGo; `fetch_url` with private-network blocking and relevant-part extraction for long pages; `@web`; `@docs:<package>` for the installed package's README.
- MCP: servers from `.agent/mcp.json`, `.vscode/mcp.json` or settings (stdio and HTTP). Tools are picked per task, calls are approved unless read-only, resources are `@mcp:` mentions, prompts are `/` commands, `/mcp` shows status. `cli --mcp-server` serves Agent Lolo's own tools to other agents.
- Memory: "remember …" saves facts to `.agent/memory.md` (reviewed), which every later conversation sees; `/memory`.
- Custom `/` commands from `.agent/commands/*.md`.
- Pasted screenshots for vision models (qwen3.5).
- Semantic code search with a local embedding model (`localAgent.embeddingModel`).
- An explore helper for vague tasks in large repositories.
- `move_file` updates the imports itself: relative `require`/`import`/`export ... from` in JS/TS (including the moved file's own) and module imports in Python.
- Fixes: a complete rewrite with a comment such as `// Existing tests...` was treated as a lazy placeholder and rejected as a syntax error; syntax-error feedback now shows the would-be code around the error, and replies cut short by an unescaped quote get an explanation the model can act on; empty files read as "empty" instead of showing only the edit hint (models copied the hint into `search`), and `create_file` refuses empty content; questions that get stuck are answered with what was found.
- Eval: 14 tasks (JS, Python, C#, Go), including renames, moves, a large file and a multi-file extraction. `scripts/finetune` prepares a LoRA fine-tune from successful runs.

## 0.3.1

- README: screenshots, quick start, mode and model guides.
- Chat: the composer toolbar no longer overflows in narrow panels.

## 0.3.0 (preview)

First public preview.

- Agent chat with conversation memory, conversation history and a context usage indicator.
- Modes: Ask before edits, Edit automatically, Plan mode (with "Run this plan"), Read-only.
- Permission prompts with diffs for edits and commands; session-wide "don't ask again".
- Checkpoints in a shadow git repository, restorable per run.
- Guard rails for small models: JSON-schema tool calls, fuzzy edit matching, tree-sitter syntax guard, automatic build/type checks, server/watch command blocking, command timeouts.
- Ctrl+I inline edit, fill-in-the-middle autocomplete, @-mentions, tree-sitter repository map.
- Built-in profiles for qwen2.5-coder, qwen3-coder and qwen3.5; first-run check for Ollama and the model.
