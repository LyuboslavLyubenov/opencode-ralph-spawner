---
name: ralph-loop
description: Structured multi-phase agentic development loop. Use when the user wants to build a feature or fix using a research → plan → implement → verify → heal cycle with fresh agent context per phase.
---

# Skill: ralph-loop

## Overview

The RALPH loop is a structured, multi-phase agentic development workflow that uses the OpenCode SDK to orchestrate separate AI sessions for planning, implementation, and verification. Each phase gets a fresh context window — state travels through files, not conversation history.

**RALPH** = **R**esearch → **A**rchitect → **L**aunch → **P**rove → **H**eal

This skill is invoked by any agent (OpenCode, Claude Code, Cursor, etc.) from any project directory. It creates a self-contained `ralph/` folder in the current working directory and bootstraps everything needed to run.

---

## When This Skill Is Invoked

When asked to "run RALPH", "start the ralph loop", or "use ralph to build X", follow these exact steps:

### Step 0 — Detect Existing RALPH Loop

**Before doing anything else**, check whether a `ralph/` directory already exists in the current working directory AND contains a `tasks.json` with at least one entry.

If it does, **skip Steps 1–5 entirely** and go straight to Step 6:

```bash
cd ralph && node ralph.js
```

The script auto-detects the previous run and launches interactive retry onboarding. It will:
1. Show a summary of what was previously built and whether verification passed.
2. Ask the user: "Do you want to iterate on this run, or start fresh?"
3. If iterating: ask what didn't work / what to change, offer (a) re-plan, (b) re-verify, or (c) adjust plan, then append the feedback to `verify-criteria.md` (and optionally `goals.md`) before continuing.
4. If starting fresh: wipe state and proceed as a new loop (the user will still need to provide new goals — you can update `ralph/goals.md` before running the script).

**Do NOT ask the Step 1 questions (fresh goal gathering) when a `ralph/` directory with tasks already exists. Let the script drive the conversation.**

---

### Step 1 — Initialize OpenCode Configuration

First, get the list of available models and ask the user which model they want to use:

```bash
# Get available models
opencode models
```

**Present the model list to the user and ask them to select one.** Do not suggest or use any default model - allow them to specify from the available options.

After the user selects a model, create the `opencode.json` file in the **project root** (current working directory, not inside `ralph/`) with the selected model:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "user-selected-model-name",
  "mcp": {
    "ddg-search": {
      "type": "local",
      "command": ["uvx", "duckduckgo-mcp-server"]
    }
  }
}
```

**Important:** The `opencode.json` must be created in the project root so `opencode serve` picks it up when `ralph.js` starts the server from that directory.

### Step 2 — Gather Goals

Ask the user these questions (all required before proceeding):

1. **What is the primary task/feature to build?** (1–3 sentence description)
2. **What are the success criteria?** (How will we know it's done? List 3–10 acceptance criteria)
3. **What is the target directory?** (Where is the codebase? Default: current working directory)
4. **What tech stack / constraints apply?** (Languages, frameworks, test commands, lint commands)
5. **What should the verifier run to check correctness?** (e.g., `npm test`, `pytest`, `cargo test`, manual checks)
6. **Are there any known constraints or things to avoid?**

Do NOT proceed to Step 3 until you have answers to all 6 questions. If the user is vague, ask follow-up questions. Think deeply about edge cases and missing context. Search the codebase if needed to understand the existing architecture before proposing anything.

### Step 3 — Create `ralph/` Directory

In the **current working directory**, create the following structure:

```
ralph/
├── goals.md
├── impl-criteria.md
├── verify-criteria.md
├── tasks.json          (starts as empty array [])
├── plan.md             (starts empty, filled by planner)
├── verification-report.md  (starts empty)
├── logs/
└── ralph.js            (the orchestrator — copy from skill)
```

Write the following files based on your gathered information:

**`ralph/goals.md`** — The full task description, success criteria, and constraints.

**`ralph/impl-criteria.md`** — Detailed implementation criteria. For each task the implementer spawns, what does "done" mean? Include:
- Files to create/modify
- Functions/classes required
- Test coverage expectations
- Linting/type-check requirements

**`ralph/verify-criteria.md`** — Verification criteria. What must be true for the whole task to be considered passing? Include:
- Exact commands to run (e.g., `npm test -- --run`, `pytest`, `ruff check .`)
- Expected outputs or exit codes
- Manual checks if needed
- Integration tests if applicable

**`ralph/tasks.json`** — Start with:
```json
[]
```
(The planner phase will populate this.)

### Step 4 — Bootstrap `ralph.js`

Copy exactly **two files** from the skill bundle into `ralph/`:

```bash
cp ~/.config/opencode/skills/ralph-loop/ralph.js ./ralph/ralph.js
cp ~/.config/opencode/skills/ralph-loop/package.json.template ./ralph/package.json
```

**Note:** The `opencode.json` file should already exist in the project root from Step 1. If not, create it now with the user's selected model.

`ralph.js` is **fully self-contained** — all agent prompts are embedded inside it. The `ralph/` folder has zero dependency on the skill directory after this copy. It can be committed to git, moved to any machine, or run independently as long as Node.js and an OpenCode server are available.

If `~` does not resolve, use the full absolute base path listed at the bottom of this file.

### Step 5 — Install Dependencies

```bash
cd ralph && npm install
```

### Step 6 — Start the RALPH Loop

```bash
cd ralph && node ralph.js
```

This will run interactively in the terminal. The RALPH orchestrator takes over from here. It automatically spawns an OpenCode server on a free port and shuts it down when the loop finishes or is interrupted — no manual `opencode serve` step is needed.

---

## What `ralph.js` Does (for reference)

The orchestrator runs these phases automatically:

```
Phase 0 — RETRY ONBOARDING (auto-triggered when a previous run is detected, or via --retry)
  Detects existing tasks.json and shows a summary of the previous run.
  Asks the user:
    1. Iterate on this run, or wipe and start fresh?
    2. (If iterating) What didn't work / what do you want to change?
    3. (If iterating) Re-plan from scratch (a), re-verify only (b), or adjust plan (c)?
  Appends feedback as a new dated section in verify-criteria.md.
  Optionally appends updated requirements to goals.md.
  Resets task/state to the appropriate phase, then continues the main loop.

Phase 1 — PLAN
  Spawns an OpenCode session with the "planner" system prompt.
  The planner reads goals.md, searches the codebase, makes reasonable assumptions
  for any ambiguous decisions (documented in the plan), and writes plan.md + tasks.json.
  Runs fully non-interactively — no user prompts. A hard timeout (10 min) prevents hangs.
  Auto-approves and moves to implementation when the planner signals RALPH_PLAN_COMPLETE.

Phase 2 — IMPLEMENT
  For each task in tasks.json (status: "pending"):
    - Spawns a fresh OpenCode session per task
    - Passes the task description + impl-criteria.md as context
    - Waits for session to complete (polls status API)
    - Marks task as "implemented"
    - Discards session (fresh context for next task)

Phase 3 — VERIFY
  Spawns a fresh OpenCode session with the "verifier" system prompt.
  The verifier reads goals.md + verify-criteria.md + tasks.json
  and runs the specified verification commands.
  Writes a pass/fail report to verification-report.md.

Phase 4 — HEAL (if failures exist)
  For each failed task in the verification report:
    - Spawns a fresh session to fix that specific issue
    - Re-runs verification after all fixes
  Repeats up to 10 cycles total.
  If still failing after 10 cycles, presents the partial report
  and hands control back to the user.
```

---

## Important Notes

- All state lives in `ralph/` files and git commits — never in conversation history
- The `ralph/` directory should be committed to git (it documents the work)
- Do NOT delete or modify `ralph/tasks.json` manually while the loop is running
- If the loop is interrupted, you can resume by running `node ralph/ralph.js --resume`
- If the user wants to retry with updated criteria, run `node ralph/ralph.js --retry`
- The `opencode` binary must be in your PATH — the script spawns its own server automatically on a free port; **you do not need to start OpenCode manually**

---

## File: Base directory

The base directory for this skill is: `file:///Users/l.lyubenov/.config/opencode/skills/ralph-loop`

Files in this skill bundle:
- `SKILL.md` — This file (instructions for the invoking agent)
- `ralph.js` — The self-contained orchestrator (copy this into the project)
- `package.json.template` — Package manifest (copy this as `package.json` alongside `ralph.js`)

The `prompts/` directory contains the raw prompt source files for reference/editing.
All prompts are embedded inside `ralph.js` — the project copy has no dependency on `prompts/`.
