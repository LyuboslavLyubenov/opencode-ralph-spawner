#!/usr/bin/env node
/**
 * RALPH Loop Orchestrator
 *
 * R - Research
 * A - Architect
 * L - Launch (implement)
 * P - Prove (verify)
 * H - Heal (fix failures)
 *
 * Usage:
 *   node ralph.js          — auto-detects: fresh start OR retry onboarding if a previous run exists
 *   node ralph.js --resume — resume an interrupted run (skip detection, continue from saved phase)
 *   node ralph.js --verify — skip to verification phase
 *   node ralph.js --retry  — force retry onboarding (same as auto-detect when previous run exists)
 *
 * Requires:
 *   - OpenCode server running at http://localhost:4096
 *   - ralph/goals.md, ralph/impl-criteria.md, ralph/verify-criteria.md already written
 *     (the invoking agent writes these before calling this script)
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RALPH_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(RALPH_DIR, "..");

const MAX_HEAL_CYCLES = 10;
const POLL_INTERVAL_MS = 2000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per session

const PATHS = {
  goals: join(RALPH_DIR, "goals.md"),
  implCriteria: join(RALPH_DIR, "impl-criteria.md"),
  verifyCriteria: join(RALPH_DIR, "verify-criteria.md"),
  plan: join(RALPH_DIR, "plan.md"),
  tasks: join(RALPH_DIR, "tasks.json"),
  verificationReport: join(RALPH_DIR, "verification-report.md"),
  logs: join(RALPH_DIR, "logs"),
  state: join(RALPH_DIR, ".ralph-state.json"),
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
};

function c(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function log(msg, color = "white") {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`${c("dim", ts)} ${c(color, msg)}`);
}

function header(title) {
  const line = "═".repeat(70);
  console.log(`\n${c("cyan", line)}`);
  console.log(c("bold", `  ${title}`));
  console.log(`${c("cyan", line)}\n`);
}

function subheader(title) {
  console.log(`\n${c("blue", "─".repeat(60))}`);
  console.log(c("blue", `  ${title}`));
  console.log(`${c("blue", "─".repeat(60))}\n`);
}

function safeRead(path, fallback = "") {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : fallback;
  } catch {
    return fallback;
  }
}

function safeReadJSON(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function logToFile(filename, content) {
  if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });
  const path = join(PATHS.logs, filename);
  const ts = new Date().toISOString();
  appendFileSync(path, `\n[${ts}]\n${content}\n`);
}

function loadState() {
  return safeReadJSON(PATHS.state, {
    phase: "plan",
    healCycles: 0,
    completedTasks: [],
    currentCycle: 1,
  });
}

function saveState(state) {
  writeJSON(PATHS.state, state);
}

// ---------------------------------------------------------------------------
// CLI input helper
// ---------------------------------------------------------------------------

function askUser(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${c("yellow", "? ")}${prompt}\n${c("cyan", "> ")}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askConfirm(prompt) {
  const answer = await askUser(`${prompt} [y/n]`);
  return answer.toLowerCase().startsWith("y");
}

// ---------------------------------------------------------------------------
// OpenCode SDK — session helpers
// ---------------------------------------------------------------------------

async function waitForIdle(client, sessionId, timeoutMs = SESSION_TIMEOUT_MS) {
  const start = Date.now();
  let seenBusy = false;

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    const statuses = await client.session.status();
    const s = statuses.data?.[sessionId] ?? statuses[sessionId];

    if (!s) {
      // Session entry is gone from the status map — completed (possibly before first poll)
      return true;
    }

    const type = s.type;

    if (type !== "idle") {
      seenBusy = true;
      if (type === "retry") {
        log(`Session retrying (attempt ${s.attempt}): ${s.message}`, "yellow");
      }
    } else {
      // type === "idle"
      if (seenBusy) {
        // Was busy, now idle — done
        return true;
      }
      // Still idle and never seen busy — session is starting up, keep waiting
    }
  }
  throw new Error(`Session ${sessionId} timed out after ${timeoutMs / 1000}s`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Get the last assistant message text from a session.
 */
async function getLastAssistantMessage(client, sessionId) {
  const resp = await client.session.messages({ path: { id: sessionId } });
  // API returns { data: [...], request, response } — unwrap
  const messages = resp?.data ?? resp;
  if (!messages || !Array.isArray(messages)) return null;
  // Assistant messages have a step-start part; user messages do not.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const parts = msg.parts || [];
    const isAssistant = parts.some((p) => p.type === "step-start");
    if (isAssistant) {
      const textParts = parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n");
      if (textParts) return textParts;
    }
  }
  return null;
}

/**
 * Get ALL messages from a session as a printable log.
 */
async function getAllMessages(client, sessionId) {
  try {
    const resp = await client.session.messages({ path: { id: sessionId } });
    const messages = resp?.data ?? resp;
    if (!messages || !Array.isArray(messages)) return [];
    return messages;
  } catch {
    return [];
  }
}

/**
 * Send a message to a session and wait for the response.
 * Returns the assistant's response text.
 */
async function sendMessage(client, sessionId, text, directory) {
  await client.session.promptAsync({
    path: { id: sessionId },
    query: directory ? { directory } : undefined,
    body: {
      parts: [{ type: "text", text }],
    },
  });

  await waitForIdle(client, sessionId);
  return await getLastAssistantMessage(client, sessionId);
}

/**
 * Create a new session and send an initial prompt.
 * Returns { sessionId, firstResponse }.
 */
async function createSessionWithPrompt(client, { title, systemPrompt, userPrompt, directory }) {
  const session = await client.session.create({ body: { title } });
  const sessionId = session.id || session.data?.id;
  if (!sessionId) throw new Error("Failed to create session — no ID returned");

  log(`Created session: ${sessionId} ("${title}")`, "dim");

  await client.session.promptAsync({
    path: { id: sessionId },
    query: directory ? { directory } : undefined,
    body: {
      system: systemPrompt || undefined,
      parts: [{ type: "text", text: userPrompt }],
    },
  });

  await waitForIdle(client, sessionId);
  const response = await getLastAssistantMessage(client, sessionId);

  return { sessionId, firstResponse: response };
}

// ---------------------------------------------------------------------------
// Embedded agent prompts — no external files needed, ralph/ is self-contained
// ---------------------------------------------------------------------------

const PROMPTS = {
  planner: `# RALPH Loop — Planner Agent

You are the RALPH Planner. Your job is to deeply research the task at hand, ask clarifying questions, and produce a precise, actionable implementation plan.

## Your Inputs

You will be given:
- \`goals.md\` — the user's high-level task goals and success criteria
- \`impl-criteria.md\` — what "done" means for each implementation task
- \`verify-criteria.md\` — how the work will be verified
- The codebase in the target directory

## Your Process

### Phase A — Research (do NOT skip this)

1. Read \`goals.md\`, \`impl-criteria.md\`, and \`verify-criteria.md\` completely.
2. Explore the codebase thoroughly:
   - Understand the existing architecture, patterns, and conventions
   - Find all files that will be touched by this work
   - Identify dependencies, constraints, and potential conflicts
   - Run any relevant commands to understand the current state (e.g., tests, builds)
3. Search the web if you need knowledge about unfamiliar libraries, APIs, or patterns.
4. Identify all ambiguities, risks, and unknowns.

### Phase B — Clarification (interactive)

After research, if there are any unresolved questions, ask the user. Be specific:
- Do not ask vague questions. Each question must be answerable with a short, specific answer.
- Do not ask more than 5 questions at once.
- Do not ask questions whose answers can be inferred from the codebase or goals.
- After each answer, confirm your understanding before proceeding.

End with: "I have enough information. Let me now produce the plan."

### Phase C — Plan Production

Write the plan to \`ralph/plan.md\`. The plan must contain:

1. **Executive Summary** — 2–3 sentences describing the approach
2. **Architecture Decisions** — Key technical choices and why
3. **Risk Register** — Potential blockers and mitigations
4. **Task Breakdown** — Ordered list of atomic tasks. Each task must be:
   - Small enough to be completed in a single fresh context window
   - Self-contained (no hidden dependencies on other tasks in-flight)
   - Unambiguous — a junior developer could implement it from the description alone

### Phase D — Tasks JSON

After writing \`plan.md\`, write the task list to \`ralph/tasks.json\`. Format:

\`\`\`json
[
  {
    "id": "task-001",
    "title": "Short descriptive title",
    "description": "Full description of what to implement. Include: files to modify, functions to write, exact behavior expected. Be specific enough that an agent with no prior context can implement this correctly.",
    "acceptanceCriteria": [
      "Criterion 1 — specific and verifiable",
      "Criterion 2"
    ],
    "status": "pending",
    "dependencies": [],
    "estimatedComplexity": "low|medium|high"
  }
]
\`\`\`

Tasks must be ordered so that dependencies come first. The \`dependencies\` array contains task IDs that must be completed before this task.

### Phase E — Handoff

After writing \`plan.md\` and \`tasks.json\`, output EXACTLY this line and nothing else:

\`\`\`
RALPH_PLAN_COMPLETE
\`\`\`

This signals to the orchestrator that the plan is ready for user review.

## Rules

- Be ruthlessly specific. Vague tasks produce broken code.
- Each task description must be self-contained. Do NOT rely on "the previous task" — write out all context.
- If a task requires touching more than 5 files, split it.
- If you are uncertain about anything, ask before producing the plan.
- Do NOT start implementing. Your only output is \`plan.md\` and \`tasks.json\`.`,

  implementer: `# RALPH Loop — Implementer Agent

You are a RALPH Implementer. You are given a single, atomic task to complete. You have a fresh context window — you have no memory of previous tasks. Everything you need is provided to you.

## Your Inputs

You will receive:
- \`TASK\`: A JSON object describing exactly what to implement
- \`GOALS\`: The content of \`ralph/goals.md\`
- \`IMPL_CRITERIA\`: The content of \`ralph/impl-criteria.md\`
- \`PLAN_SUMMARY\`: The executive summary from \`ralph/plan.md\`

## Your Rules

1. **Implement exactly what the task says.** Do not add extra features, do not refactor unrelated code.
2. **Read before you write.** Before modifying any file, read its current content.
3. **Follow existing conventions.** Match the code style, naming, and patterns of the surrounding code.
4. **Run quality checks after implementation.** If the task description or impl-criteria.md specifies test/lint commands, run them after you are done.
5. **Fix failures before finishing.** If a test or lint check fails due to your changes, fix it before completing.
6. **Commit when done.** After all checks pass, commit your changes with a descriptive message. Format: \`feat(ralph): [task-id] short description\`
7. **Do NOT modify \`ralph/\` files** — except you may append a brief note to \`ralph/logs/\` if needed.
8. **Do NOT work outside the scope of your task.** If you discover something broken that is outside your task, note it in \`ralph/logs/task-XXX-notes.md\` and leave it.

## Output When Complete

When your task is fully implemented and committed, output EXACTLY this on the last line:

\`\`\`
RALPH_TASK_COMPLETE: [task-id]
\`\`\`

If you cannot complete the task (blocked, missing info, conflict), output:

\`\`\`
RALPH_TASK_BLOCKED: [task-id] — [reason in 1 sentence]
\`\`\``,

  verifier: `# RALPH Loop — Verifier Agent

You are a RALPH Verifier. Your job is to rigorously verify whether the implementation meets the stated goals and criteria. You are objective and precise — you do not give partial credit or assume intent.

## Your Inputs

- \`ralph/goals.md\` — The user's stated goals and success criteria
- \`ralph/verify-criteria.md\` — Specific verification commands and expected outcomes
- \`ralph/tasks.json\` — The complete task list with statuses
- \`ralph/plan.md\` — The implementation plan
- The codebase itself

## Your Process

### Step 1 — Check Task Statuses First

Before running any commands, inspect the \`tasks.json\` you were given.

If ANY task has status \`"blocked"\` or \`"error"\`, the overall run is an **automatic FAIL**. Do not skip this check. Record each such task in the Failures section of your report with:
- Task ID and title
- The \`statusNote\` field (if present) explaining why it was blocked/errored
- Suggested Fix: re-run the implement phase for that task

Only proceed to Step 2 if all tasks are \`"implemented"\`, \`"completed"\`, or \`"passed"\`.

### Step 2 — Run All Verification Commands

Execute every command listed in \`ralph/verify-criteria.md\`. Record:
- The exact command run
- The exit code
- The output (first 500 chars if long)
- Pass or fail verdict

Do not skip any command. Do not assume a command passes without running it.

### Step 3 — Review Implementation Against Goals

For each success criterion in \`ralph/goals.md\`:
- Determine whether it is met (yes/no/partial)
- Cite specific evidence (file:line, test output, etc.)
- If partial or no, explain exactly what is missing

### Step 4 — Review Each Task

For each task in \`ralph/tasks.json\`:
- Check its acceptance criteria one by one
- Mark as: PASS / FAIL / PARTIAL / SKIPPED
- For FAIL or PARTIAL, list what specifically is wrong

### Step 5 — Write Verification Report

Write \`ralph/verification-report.md\` with this exact structure:

\`\`\`markdown
# RALPH Verification Report
**Cycle:** [N]
**Date:** [ISO date]
**Overall Status:** PASS | PARTIAL | FAIL

## Summary
[2-3 sentences]

## Verification Commands
| Command | Exit Code | Status |
|---------|-----------|--------|
| \`npm test\` | 0 | PASS |
| \`ruff check .\` | 1 | FAIL |

## Goal Criteria
| Criterion | Status | Evidence |
|-----------|--------|----------|
| ... | PASS | ... |

## Task Results
| Task ID | Title | Status | Notes |
|---------|-------|--------|-------|
| task-001 | ... | PASS | |

## Failures (if any)
### [task-id or goal criterion]
**Issue:** [exact description]
**Evidence:** [command output / file:line]
**Suggested Fix:** [specific, actionable]

## Passed Items
[Brief list]
\`\`\`

### Step 6 — Signal

After writing the report, output EXACTLY one of:

\`\`\`
RALPH_VERIFY_PASS
\`\`\`

or:

\`\`\`
RALPH_VERIFY_FAIL: [N] failures found
\`\`\`

## Rules

- Do NOT modify any source files.
- Do NOT suggest improvements beyond what is strictly required to pass the criteria.
- Be exact. "It seems to work" is not evidence. Run the command and record the output.
- If a verification command is missing (not installed, wrong path), note it as a blocking issue.`,
};

function loadPrompt(name) {
  if (!PROMPTS[name]) throw new Error(`Unknown prompt: ${name}`);
  return PROMPTS[name];
}

// ---------------------------------------------------------------------------
// Phase 1 — PLAN
// ---------------------------------------------------------------------------

async function runPlanPhase(client, state) {
  header("PHASE 1 — RESEARCH & PLAN");

  // Verify required files exist
  const missingFiles = [PATHS.goals, PATHS.implCriteria, PATHS.verifyCriteria].filter(
    (p) => !existsSync(p)
  );
  if (missingFiles.length > 0) {
    log("Missing required files:", "red");
    missingFiles.forEach((f) => log(`  ${f}`, "red"));
    log(
      "The invoking agent should have written these. See SKILL.md for instructions.",
      "red"
    );
    process.exit(1);
  }

  const goals = readFileSync(PATHS.goals, "utf8");
  const implCriteria = readFileSync(PATHS.implCriteria, "utf8");
  const verifyCriteria = readFileSync(PATHS.verifyCriteria, "utf8");
  const plannerPrompt = loadPrompt("planner");

  log("Starting planner session...", "cyan");

  const initialUserMessage = `
Please begin the RALPH planning process for this task.

## Goals
${goals}

## Implementation Criteria
${implCriteria}

## Verification Criteria
${verifyCriteria}

## Project Directory
${PROJECT_DIR}

Start by reading the codebase, then ask me any clarifying questions you have.
When you have enough information, write the plan to ralph/plan.md and tasks list to ralph/tasks.json.
Signal completion with RALPH_PLAN_COMPLETE on its own line.
`.trim();

  const { sessionId, firstResponse } = await createSessionWithPrompt(client, {
    title: "RALPH Planner",
    systemPrompt: plannerPrompt,
    userPrompt: initialUserMessage,
    directory: PROJECT_DIR,
  });

  log(`Planner session active. Entering Q&A loop.`, "green");
  console.log();

  // Interactive Q&A loop
  let response = firstResponse;
  let planComplete = false;

  while (!planComplete) {
    if (!response) {
      log("No response from planner yet. Type 'done' to push it to finish, or wait.", "dim");
    } else {
      // Print the planner's response
      console.log(c("magenta", "\n[Planner]"));
      console.log(response);
      console.log();

      // Check for completion signal
      if (response.includes("RALPH_PLAN_COMPLETE")) {
        planComplete = true;
        log("Planner has completed the plan.", "green");
        break;
      }
    }

    // Prompt user for reply
    const userReply = await askUser(
      "Your reply to the planner (or type 'done' if the planner already has enough info):"
    );

    if (userReply.toLowerCase() === "done") {
      // Push the planner to finish
      response = await sendMessage(
        client,
        sessionId,
        "You have enough information. Please now write ralph/plan.md and ralph/tasks.json, then output RALPH_PLAN_COMPLETE.",
        PROJECT_DIR
      );
    } else {
      response = await sendMessage(client, sessionId, userReply, PROJECT_DIR);
    }
  }

  // Verify plan files were written
  if (!existsSync(PATHS.plan)) {
    log("Planner did not write plan.md. Prompting...", "yellow");
    response = await sendMessage(
      client,
      sessionId,
      "Please write your plan to ralph/plan.md and your task list to ralph/tasks.json now, then output RALPH_PLAN_COMPLETE.",
      PROJECT_DIR
    );
    console.log(c("magenta", "\n[Planner]"));
    console.log(response);
  }

  const tasks = safeReadJSON(PATHS.tasks, null);
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    log("tasks.json is empty or missing. Cannot proceed.", "red");
    log("Check ralph/plan.md for the plan, then manually create ralph/tasks.json.", "yellow");
    process.exit(1);
  }

  // Clean up planner session
  try {
    await client.session.delete({ path: { id: sessionId } });
  } catch {
    // non-fatal
  }

  // Show plan summary
  subheader("Plan Summary");
  const plan = safeRead(PATHS.plan);
  // Print first 1000 chars of plan
  console.log(plan.substring(0, 1000));
  if (plan.length > 1000) console.log(c("dim", `... (${plan.length} chars total, see ralph/plan.md)`));
  console.log();
  log(`Task count: ${tasks.length}`, "green");
  tasks.forEach((t, i) => {
    const complexity = t.estimatedComplexity || "?";
    console.log(`  ${i + 1}. ${c("cyan", t.id)} — ${t.title} ${c("dim", `[${complexity}]`)}`);
  });
  console.log();

  // User approval
  const approved = await askConfirm("Does this plan look correct? Approve to begin implementation?");
  if (!approved) {
    const feedback = await askUser(
      "What needs to change? (Your feedback will be sent back to the planner)"
    );
    log("Returning to planner for revisions...", "yellow");

    // Restart plan phase with feedback
    state.planFeedback = feedback;
    // Reopen a new planner session with feedback
    const revisionSession = await createSessionWithPrompt(client, {
      title: "RALPH Planner (Revision)",
      systemPrompt: plannerPrompt,
      userPrompt: `
${initialUserMessage}

---

PREVIOUS PLAN WAS REJECTED. User feedback:
${feedback}

Please revise your plan accordingly. Read ralph/plan.md to see what you produced before.
Then update ralph/plan.md and ralph/tasks.json with the revised plan.
Output RALPH_PLAN_COMPLETE when done.
`.trim(),
      directory: PROJECT_DIR,
    });

    let revResponse = revisionSession.firstResponse;
    let revPlanComplete = false;
    while (!revPlanComplete) {
      if (!revResponse) {
        log("No response from planner.", "dim");
      } else {
        console.log(c("magenta", "\n[Planner]"));
        console.log(revResponse);
        console.log();
        if (revResponse.includes("RALPH_PLAN_COMPLETE")) {
          revPlanComplete = true;
          log("Planner has completed the plan.", "green");
          break;
        }
      }
      const reply = await askUser("Reply (or 'done' to push to completion):");
      if (reply.toLowerCase() === "done") {
        revResponse = await sendMessage(
          client,
          revisionSession.sessionId,
          "Finalize the plan now. Write ralph/plan.md and ralph/tasks.json, then output RALPH_PLAN_COMPLETE.",
          PROJECT_DIR
        );
      } else {
        revResponse = await sendMessage(client, revisionSession.sessionId, reply, PROJECT_DIR);
      }
    }
    try {
      await client.session.delete({ path: { id: revisionSession.sessionId } });
    } catch {}

    return runPlanPhase(client, state); // recursive re-review
  }

  state.phase = "implement";
  state.planApproved = true;
  saveState(state);
  log("Plan approved. Moving to implementation.", "green");
}

// ---------------------------------------------------------------------------
// Phase 2 — IMPLEMENT
// ---------------------------------------------------------------------------

async function runImplementPhase(client, state) {
  header("PHASE 2 — IMPLEMENTATION");

  const tasks = safeReadJSON(PATHS.tasks, []);
  const goals = safeRead(PATHS.goals);
  const implCriteria = safeRead(PATHS.implCriteria);
  const plan = safeRead(PATHS.plan);
  const implementerPrompt = loadPrompt("implementer");

  // Extract plan summary (first section)
  const planSummary = plan.split("\n").slice(0, 20).join("\n");

  const pending = tasks.filter(
    (t) => t.status === "pending" || t.status === "failed"
  );

  if (pending.length === 0) {
    log("No pending tasks found. All tasks already completed.", "green");
    state.phase = "verify";
    saveState(state);
    return;
  }

  log(`Implementing ${pending.length} task(s)...`, "cyan");

  for (const task of pending) {
    // Check dependencies
    const blockedBy = (task.dependencies || []).filter((depId) => {
      const dep = tasks.find((t) => t.id === depId);
      return dep && dep.status !== "implemented" && dep.status !== "passed";
    });

    if (blockedBy.length > 0) {
      log(`Skipping ${task.id} — blocked by: ${blockedBy.join(", ")}`, "yellow");
      continue;
    }

    subheader(`Task: ${task.id} — ${task.title}`);
    log(`Complexity: ${task.estimatedComplexity || "unknown"}`, "dim");
    console.log(c("dim", task.description.substring(0, 200)));
    console.log();

    const taskPrompt = `
## Your Task
${JSON.stringify(task, null, 2)}

## Project Goals
${goals}

## Implementation Criteria
${implCriteria}

## Plan Summary (for context only — implement YOUR task only)
${planSummary}

## Project Directory
${PROJECT_DIR}

Implement this task now. Follow the rules in your system prompt.
When complete, output RALPH_TASK_COMPLETE: ${task.id} on its own line.
If blocked, output RALPH_TASK_BLOCKED: ${task.id} — [reason].
`.trim();

    try {
      const { sessionId, firstResponse } = await createSessionWithPrompt(client, {
        title: `RALPH Impl: ${task.id}`,
        systemPrompt: implementerPrompt,
        userPrompt: taskPrompt,
        directory: PROJECT_DIR,
      });

      log(`Session ${sessionId} running...`, "dim");

      let response = firstResponse;
      let taskDone = false;
      let taskBlocked = false;
      let blockReason = "";
      let lastChangeAt = Date.now();
      let nudgeCount = 0;
      const STALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes with no new message
      const MAX_NUDGES = 2;

      // Wait for completion signal by polling last message
      while (!taskDone && !taskBlocked) {
        await sleep(POLL_INTERVAL_MS);
        const latest = await getLastAssistantMessage(client, sessionId);

        if (latest && latest !== response) {
          response = latest;
          lastChangeAt = Date.now();
        }

        if (!response) continue;

        if (response.includes(`RALPH_TASK_COMPLETE: ${task.id}`)) {
          taskDone = true;
        } else if (response.includes(`RALPH_TASK_BLOCKED: ${task.id}`)) {
          taskBlocked = true;
          const match = response.match(/RALPH_TASK_BLOCKED: .+? — (.+)/);
          blockReason = match ? match[1] : "Unknown reason";
        } else if (Date.now() - lastChangeAt > STALL_TIMEOUT_MS) {
          if (nudgeCount >= MAX_NUDGES) {
            log(`Task ${task.id}: no signal after ${MAX_NUDGES} nudges, marking blocked.`, "yellow");
            taskBlocked = true;
            blockReason = `No completion signal after ${MAX_NUDGES} nudges`;
          } else {
            nudgeCount++;
            log(`Task ${task.id}: stalled for 3 min, sending nudge ${nudgeCount}/${MAX_NUDGES}.`, "yellow");
            // sendMessage calls waitForIdle internally — response will be updated on next poll
            sendMessage(
              client,
              sessionId,
              `Have you completed task ${task.id}? If so output RALPH_TASK_COMPLETE: ${task.id} now. If blocked, output RALPH_TASK_BLOCKED: ${task.id} — [reason].`,
              PROJECT_DIR
            ).catch(() => {}); // fire-and-forget — polling loop will pick up the response
            lastChangeAt = Date.now(); // reset timer so we wait another 3 min before next nudge
          }
        }
      }

      // Log output
      logToFile(
        `task-${task.id}.log`,
        `Task: ${task.title}\nStatus: ${taskDone ? "COMPLETE" : "BLOCKED"}\nResponse:\n${response}`
      );

      // Clean up session
      try {
        await client.session.delete({ path: { id: sessionId } });
      } catch {}

      // Update task status
      if (taskDone) {
        log(`Task ${task.id} complete.`, "green");
        updateTaskStatus(tasks, task.id, "implemented");
      } else {
        log(`Task ${task.id} BLOCKED: ${blockReason}`, "red");
        updateTaskStatus(tasks, task.id, "blocked", blockReason);
      }

      writeJSON(PATHS.tasks, tasks);
    } catch (err) {
      log(`Error implementing ${task.id}: ${err.message}`, "red");
      updateTaskStatus(tasks, task.id, "error", err.message);
      writeJSON(PATHS.tasks, tasks);
    }

    // Brief pause between tasks
    await sleep(1000);
  }

  const implemented = tasks.filter((t) => t.status === "implemented").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const errored = tasks.filter((t) => t.status === "error").length;

  subheader("Implementation Summary");
  log(`Implemented: ${implemented}`, "green");
  if (blocked > 0) log(`Blocked: ${blocked}`, "yellow");
  if (errored > 0) log(`Errors: ${errored}`, "red");

  state.phase = "verify";
  saveState(state);
}

function updateTaskStatus(tasks, id, status, note) {
  const task = tasks.find((t) => t.id === id);
  if (task) {
    task.status = status;
    if (note) task.statusNote = note;
    task.completedAt = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — VERIFY
// ---------------------------------------------------------------------------

async function runVerifyPhase(client, state) {
  header(`PHASE 3 — VERIFY (Cycle ${state.currentCycle})`);

  const goals = safeRead(PATHS.goals);
  const verifyCriteria = safeRead(PATHS.verifyCriteria);
  const tasks = safeReadJSON(PATHS.tasks, []);
  const plan = safeRead(PATHS.plan);
  const verifierPrompt = loadPrompt("verifier");

  const verifierMessage = `
Please verify the implementation of the following task.

## Goals
${goals}

## Verification Criteria
${verifyCriteria}

## Tasks (${tasks.length} total)
${JSON.stringify(tasks, null, 2)}

## Plan Summary
${plan.substring(0, 1000)}

## Project Directory
${PROJECT_DIR}

## Cycle
${state.currentCycle}

Run all verification commands from verify-criteria.md.
Check each success criterion in goals.md.
Write your report to ralph/verification-report.md.
End with RALPH_VERIFY_PASS or RALPH_VERIFY_FAIL: [N] failures found.
`.trim();

  const { sessionId, firstResponse } = await createSessionWithPrompt(client, {
    title: `RALPH Verifier (Cycle ${state.currentCycle})`,
    systemPrompt: verifierPrompt,
    userPrompt: verifierMessage,
    directory: PROJECT_DIR,
  });

  log(`Verifier session ${sessionId} running...`, "dim");

  let response = firstResponse;
  let verifyDone = false;
  let verifyPassed = false;
  let failureCount = 0;
  let lastChangeAt = Date.now();
  let nudgeCount = 0;
  const STALL_TIMEOUT_MS = 3 * 60 * 1000;
  const MAX_NUDGES = 2;

  while (!verifyDone) {
    await sleep(POLL_INTERVAL_MS);
    const latest = await getLastAssistantMessage(client, sessionId);

    if (latest && latest !== response) {
      response = latest;
      lastChangeAt = Date.now();
    }

    if (!response) continue;

    if (response.includes("RALPH_VERIFY_PASS")) {
      verifyDone = true;
      verifyPassed = true;
    } else if (response.includes("RALPH_VERIFY_FAIL")) {
      verifyDone = true;
      verifyPassed = false;
      const match = response.match(/RALPH_VERIFY_FAIL: (\d+)/);
      failureCount = match ? parseInt(match[1]) : 1;
    } else if (Date.now() - lastChangeAt > STALL_TIMEOUT_MS) {
      if (nudgeCount >= MAX_NUDGES) {
        log("Verifier: no signal after nudges, treating as failure.", "yellow");
        verifyDone = true;
        verifyPassed = false;
        failureCount = 1;
      } else {
        nudgeCount++;
        log(`Verifier stalled, sending nudge ${nudgeCount}/${MAX_NUDGES}.`, "yellow");
        sendMessage(
          client,
          sessionId,
          "Please finalize your verification report at ralph/verification-report.md, then output RALPH_VERIFY_PASS or RALPH_VERIFY_FAIL: [N] failures found.",
          PROJECT_DIR
        ).catch(() => {});
        lastChangeAt = Date.now();
      }
    }
  }

  logToFile(`verify-cycle-${state.currentCycle}.log`, response || "");

  try {
    await client.session.delete({ path: { id: sessionId } });
  } catch {}

  if (verifyPassed) {
    state.phase = "complete";
    saveState(state);
    log("All verification checks passed!", "green");
    return { passed: true };
  } else {
    log(`Verification failed: ${failureCount} failure(s) found.`, "red");
    return { passed: false, failureCount };
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — HEAL
// ---------------------------------------------------------------------------

async function runHealPhase(client, state) {
  if (state.healCycles >= MAX_HEAL_CYCLES) {
    log(
      `Max heal cycles reached (${MAX_HEAL_CYCLES}). Stopping and presenting partial report.`,
      "red"
    );
    return false;
  }

  state.healCycles = (state.healCycles || 0) + 1;
  state.currentCycle = (state.currentCycle || 1) + 1;
  state.phase = "implement";
  saveState(state);

  header(`PHASE 4 — HEAL (Cycle ${state.healCycles}/${MAX_HEAL_CYCLES})`);

  const report = safeRead(PATHS.verificationReport);
  const tasks = safeReadJSON(PATHS.tasks, []);
  const implementerPrompt = loadPrompt("implementer");

  log("Parsing failures from verification report...", "cyan");

  // Parse the ## Failures section to extract implicated task IDs.
  // This scopes the heal to only the tasks that actually caused a failure,
  // rather than re-running every non-passed task.
  const failedTaskIds = new Set();
  const failuresSection = report.match(/## Failures[\s\S]*?(?=\n## |$)/)?.[0] ?? "";

  // Match explicit task IDs mentioned in the Failures section (e.g. "task-001", "001")
  const taskIdMatches = failuresSection.matchAll(/\btask[-_]?(\d+)\b/gi);
  for (const m of taskIdMatches) {
    // Normalise to the format used in tasks.json (e.g. "001")
    const padded = m[1].padStart(3, "0");
    // Try both "001" and "task-001" forms
    const task = tasks.find((t) => t.id === padded || t.id === `task-${padded}` || t.id === `00${padded}`);
    if (task) failedTaskIds.add(task.id);
  }

  // Also always include any task already in blocked/error state
  tasks.forEach((t) => {
    if (t.status === "blocked" || t.status === "error") failedTaskIds.add(t.id);
  });

  if (failedTaskIds.size === 0) {
    // Fallback: look for FAIL anywhere in the Task Results table
    const tableSection = report.match(/## Task Results[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
    for (const line of tableSection.split("\n")) {
      if (line.includes("FAIL") && !line.includes("PARTIAL")) {
        const idMatch = line.match(/\b(\d{3})\b/);
        if (idMatch) {
          const task = tasks.find((t) => t.id === idMatch[1] || t.id === `task-${idMatch[1]}`);
          if (task) failedTaskIds.add(task.id);
        }
      }
    }
  }

  if (failedTaskIds.size === 0) {
    log("Could not identify specific failed tasks — re-running all non-passed tasks.", "yellow");
    tasks.forEach((t) => {
      if (t.status !== "passed" && t.status !== "completed") t.status = "failed";
    });
  } else {
    log(`Tasks implicated by failures: ${[...failedTaskIds].join(", ")}`, "yellow");
    failedTaskIds.forEach((id) => {
      const task = tasks.find((t) => t.id === id);
      if (task) task.status = "failed";
    });
  }

  writeJSON(PATHS.tasks, tasks);

  // Only heal tasks explicitly marked failed (scoped by the analysis above)
  const failedTasks = tasks.filter((t) => t.status === "failed");

  if (failedTasks.length === 0) {
    log("No tasks marked for healing.", "yellow");
    return true;
  }

  log(`Healing ${failedTasks.length} task(s)...`, "cyan");

  const goals = safeRead(PATHS.goals);
  const implCriteria = safeRead(PATHS.implCriteria);

  for (const task of failedTasks) {
    subheader(`Healing: ${task.id} — ${task.title}`);

    const healPrompt = `
## Your Task (HEAL/FIX)
${JSON.stringify(task, null, 2)}

## What Went Wrong
Check ralph/verification-report.md for specific failures related to this task.

## Goals
${goals}

## Implementation Criteria
${implCriteria}

## Project Directory
${PROJECT_DIR}

This task failed verification. Fix the issues identified in the verification report.
Read ralph/verification-report.md first to understand exactly what failed.
When fixed and all checks pass, output RALPH_TASK_COMPLETE: ${task.id}.
If still blocked, output RALPH_TASK_BLOCKED: ${task.id} — [reason].
`.trim();

    try {
      const { sessionId, firstResponse } = await createSessionWithPrompt(client, {
        title: `RALPH Heal: ${task.id} (cycle ${state.healCycles})`,
        systemPrompt: implementerPrompt,
        userPrompt: healPrompt,
        directory: PROJECT_DIR,
      });

      let response = firstResponse;
      let done = false;
      let blocked = false;
      let lastChangeAt = Date.now();
      let nudgeCount = 0;
      const STALL_TIMEOUT_MS = 3 * 60 * 1000;
      const MAX_NUDGES = 2;

      while (!done && !blocked) {
        await sleep(POLL_INTERVAL_MS);
        const latest = await getLastAssistantMessage(client, sessionId);

        if (latest && latest !== response) {
          response = latest;
          lastChangeAt = Date.now();
        }

        if (!response) continue;

        if (response.includes(`RALPH_TASK_COMPLETE: ${task.id}`)) {
          done = true;
        } else if (response.includes(`RALPH_TASK_BLOCKED: ${task.id}`)) {
          blocked = true;
        } else if (Date.now() - lastChangeAt > STALL_TIMEOUT_MS) {
          if (nudgeCount >= MAX_NUDGES) {
            log(`Heal ${task.id}: no signal after ${MAX_NUDGES} nudges, marking blocked.`, "yellow");
            blocked = true;
          } else {
            nudgeCount++;
            log(`Heal ${task.id}: stalled, sending nudge ${nudgeCount}/${MAX_NUDGES}.`, "yellow");
            sendMessage(
              client,
              sessionId,
              `Have you finished fixing task ${task.id}? Output RALPH_TASK_COMPLETE: ${task.id} or RALPH_TASK_BLOCKED: ${task.id} — [reason].`,
              PROJECT_DIR
            ).catch(() => {});
            lastChangeAt = Date.now();
          }
        }
      }

      logToFile(`heal-${task.id}-cycle${state.healCycles}.log`, response || "");

      try {
        await client.session.delete({ path: { id: sessionId } });
      } catch {}

      if (done) {
        log(`Healed ${task.id}`, "green");
        updateTaskStatus(tasks, task.id, "implemented");
      } else {
        log(`${task.id} still blocked after heal attempt`, "red");
        updateTaskStatus(tasks, task.id, "blocked");
      }

      writeJSON(PATHS.tasks, tasks);
    } catch (err) {
      log(`Error healing ${task.id}: ${err.message}`, "red");
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

function printFinalReport(passed, state) {
  header("RALPH LOOP COMPLETE");

  const report = safeRead(PATHS.verificationReport);
  const tasks = safeReadJSON(PATHS.tasks, []);

  const stats = {
    total: tasks.length,
    implemented: tasks.filter((t) => t.status === "implemented" || t.status === "passed").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    pending: tasks.filter((t) => t.status === "pending").length,
  };

  if (passed) {
    console.log(c("green", "  STATUS: ALL CHECKS PASSED"));
  } else {
    console.log(c("red", "  STATUS: SOME CHECKS FAILED"));
    console.log(c("yellow", `  Heal cycles used: ${state.healCycles}/${MAX_HEAL_CYCLES}`));
  }

  console.log();
  console.log(`  Tasks: ${stats.implemented}/${stats.total} complete`);
  if (stats.blocked > 0) console.log(c("yellow", `  Blocked: ${stats.blocked}`));
  if (stats.failed > 0) console.log(c("red", `  Failed: ${stats.failed}`));
  if (stats.pending > 0) console.log(c("yellow", `  Pending: ${stats.pending}`));

  console.log();
  console.log(c("dim", `  Report: ${PATHS.verificationReport}`));
  console.log(c("dim", `  Tasks:  ${PATHS.tasks}`));
  console.log(c("dim", `  Logs:   ${PATHS.logs}`));
  console.log();

  if (!passed) {
    console.log(c("yellow", "  Next steps:"));
    console.log(c("yellow", `  1. Review ralph/verification-report.md`));
    console.log(c("yellow", `  2. Fix remaining issues manually`));
    console.log(c("yellow", `  3. Re-run: node ralph/ralph.js --verify`));
  }

  console.log(`\n${c("cyan", "═".repeat(70))}\n`);
}

// ---------------------------------------------------------------------------
// Retry onboarding — ask user what failed and update criteria files
// ---------------------------------------------------------------------------

async function runRetryOnboarding(client, state) {
  header("RALPH — Previous Run Detected");

  // Summarise previous run
  const report = safeRead(PATHS.verificationReport);
  const goals = safeRead(PATHS.goals);
  const tasks = safeReadJSON(PATHS.tasks, []);

  const prevStatus = report.match(/\*\*Overall Status:\*\*\s*(\w+)/)?.[1] ?? "unknown";
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(
    (t) => t.status === "implemented" || t.status === "passed" || t.status === "completed"
  ).length;

  subheader("Previous Run Summary");
  log(`Overall verification status: ${prevStatus}`, prevStatus === "PASS" ? "green" : "red");
  log(`Tasks: ${completedTasks}/${totalTasks} completed`, "cyan");
  if (report) {
    const summaryMatch = report.match(/## Summary\n([\s\S]*?)(?=\n##|$)/);
    if (summaryMatch) {
      console.log(c("dim", summaryMatch[1].trim().substring(0, 600)));
    }
  }
  console.log();

  // Ask if they want to continue with retry or start fresh entirely
  const wantRetry = await askConfirm(
    "Do you want to iterate on this run? (No = wipe everything and start a brand new RALPH loop)"
  );

  if (!wantRetry) {
    log("Starting fresh. Clearing previous state...", "yellow");
    writeFileSync(PATHS.plan, "");
    writeFileSync(PATHS.verificationReport, "");
    writeJSON(PATHS.tasks, []);
    const newState = { phase: "plan", healCycles: 0, currentCycle: 1 };
    saveState(newState);
    return newState;
  }

  // Ask what didn't work
  const whatFailed = await askUser(
    "What didn't work, or what do you want to change? (Describe failures, wrong outputs, missing features, or new requirements)"
  );

  // Ask what kind of retry
  console.log();
  console.log(c("cyan", "How do you want to proceed?"));
  console.log(c("dim", "  a) Re-plan from scratch (keep goals + feedback, redo plan + tasks)"));
  console.log(c("dim", "  b) Keep the plan, just re-run verification (output changed, criteria need updating)"));
  console.log(c("dim", "  c) Adjust plan only (keep implemented tasks, fix the plan for remaining ones)"));
  console.log();
  const retryChoice = await askUser("Enter a, b, or c:");
  const choice = retryChoice.toLowerCase().trim()[0];

  // Translate feedback into concrete criteria via an OpenCode session
  log("Translating feedback into concrete verification criteria...", "cyan");

  const existingCriteria = safeRead(PATHS.verifyCriteria);
  const translatorMessage = `
You are a verification criteria writer for the RALPH agentic development loop.

A user has provided feedback about a previous run. Your job is to translate their natural language feedback into concrete, machine-verifiable criteria that can be added to verify-criteria.md.

## User Feedback
${whatFailed}

## Existing verify-criteria.md (for context — do NOT repeat existing criteria)
${existingCriteria}

## Goals (for context)
${safeRead(PATHS.goals)}

## Your Task

Write ONLY the new criteria section to add — do not rewrite the whole file.
Format it exactly as:

## User Feedback Criteria — ${new Date().toISOString().split("T")[0]}

[For each point in the feedback, write:]
### [Short criterion title]
[1-sentence description of what must be true]
\`\`\`bash
[Exact shell command to verify it, if applicable]
\`\`\`
Expected: [what the command should output or what condition must hold]

Rules:
- Be specific and measurable. "More repo_urls" → "At least 80% of entries must have a non-null repo_url".
- Every criterion must be independently verifiable by running a command or inspecting a file.
- Do not include criteria already covered in the existing verify-criteria.md.
- Output ONLY the new markdown section. No preamble, no explanation.
`.trim();

  let translatedCriteria = null;
  try {
    log("Spawning criteria translator session...", "dim");
    const { sessionId, firstResponse } = await createSessionWithPrompt(client, {
      title: "RALPH Criteria Translator",
      systemPrompt: "You are a precise technical writer. Output only the requested markdown section, nothing else. Do NOT explore any files or run any commands.",
      userPrompt: translatorMessage,
      // No directory — this is pure text transformation, not a coding session
    });

    // Validate the response is non-empty and looks like markdown (starts with ##)
    const trimmed = (firstResponse || "").trim();
    if (trimmed.length > 50 && trimmed.startsWith("##")) {
      translatedCriteria = trimmed;
      log("Criteria translated successfully.", "green");
    } else if (trimmed.length > 0) {
      // Response exists but doesn't look like the expected format — nudge it
      log("Translator response unexpected format, nudging...", "yellow");
      log(`Raw response (first 200 chars): ${trimmed.substring(0, 200)}`, "dim");
      const nudged = await sendMessage(
        client,
        sessionId,
        `Your response must start with a markdown heading "## User Feedback Criteria — ..." and contain concrete shell commands. Please rewrite it in that format now. Output ONLY the markdown section.`
      );
      const nudgedTrimmed = (nudged || "").trim();
      if (nudgedTrimmed.length > 50 && nudgedTrimmed.startsWith("##")) {
        translatedCriteria = nudgedTrimmed;
        log("Criteria translated successfully after nudge.", "green");
      } else {
        log("Translator still returned bad format after nudge — falling back to raw feedback.", "yellow");
        log(`Nudge response: ${nudgedTrimmed.substring(0, 200)}`, "dim");
      }
    } else {
      log("Translator returned empty response — falling back to raw feedback.", "yellow");
    }

    try { await client.session.delete({ path: { id: sessionId } }); } catch {}
  } catch (err) {
    log(`Criteria translation session failed: ${err.message}`, "yellow");
    log("Falling back to raw feedback.", "dim");
  }

  // Write translated (or raw fallback) criteria to verify-criteria.md
  const date = new Date().toISOString().split("T")[0];
  const feedbackSection = translatedCriteria
    ? `\n\n${translatedCriteria}\n`
    : `\n\n## User Feedback (raw) — ${date}\n\n> Translation failed — raw user input below. The implementer/healer should interpret this.\n\n${whatFailed}\n`;

  writeFileSync(PATHS.verifyCriteria, existingCriteria + feedbackSection);
  log("Updated verify-criteria.md with translated criteria.", "green");
  console.log();
  console.log(c("dim", "--- New criteria added ---"));
  console.log(c("dim", feedbackSection.trim().substring(0, 500)));
  console.log();

  // Auto-detect if feedback contains numeric thresholds or requirement changes
  // and mirror them to goals.md without prompting the user
  const hasNumericThreshold = /\d+\s*%|\bat least\b|\bminimum\b|\bmore than\b|\ball\b.*\bmust\b/i.test(whatFailed);
  const goalsContent = safeRead(PATHS.goals);
  if (hasNumericThreshold || translatedCriteria) {
    const updatedGoalsSection = `\n\n## Updated Success Criteria — ${date}\n\n${translatedCriteria ? translatedCriteria : whatFailed}\n`;
    writeFileSync(PATHS.goals, goalsContent + updatedGoalsSection);
    log("Mirrored updated criteria to goals.md.", "green");
  }

  // Adjust task statuses and state based on choice
  if (choice === "a") {
    // Re-plan: reset all tasks to pending, wipe plan, go back to plan phase
    tasks.forEach((t) => {
      t.status = "pending";
      delete t.statusNote;
      delete t.completedAt;
    });
    writeJSON(PATHS.tasks, tasks);
    // Clear plan so planner rewrites it
    writeFileSync(PATHS.plan, "");
    state.phase = "plan";
    state.healCycles = 0;
    state.currentCycle = 1;
    delete state.planApproved;
    log("Reset to plan phase. The planner will re-plan from scratch.", "yellow");
  } else if (choice === "b") {
    // Re-verify only — jump straight to verify
    state.phase = "verify";
    state.currentCycle = (state.currentCycle || 1) + 1;
    state.healCycles = 0;
    log("Jumping to verify phase with updated criteria.", "yellow");
  } else {
    // Adjust plan: mark implemented tasks as "completed", pending/failed as "pending"
    tasks.forEach((t) => {
      if (t.status === "implemented" || t.status === "passed") {
        t.status = "completed";
      } else if (t.status === "failed" || t.status === "error" || t.status === "blocked") {
        t.status = "pending";
        delete t.statusNote;
      }
    });
    writeJSON(PATHS.tasks, tasks);
    state.phase = "plan";
    state.healCycles = 0;
    log("Returning to plan phase to adjust remaining tasks.", "yellow");
  }

  saveState(state);
  console.log();
  log("Feedback collected. Proceeding with updated criteria...", "green");
  console.log();

  return state;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const resumeMode = args.includes("--resume");
  const verifyOnly = args.includes("--verify");
  const retryMode = args.includes("--retry");

  header("RALPH LOOP ORCHESTRATOR");
  log(`Project: ${PROJECT_DIR}`, "cyan");
  log(`Ralph state: ${RALPH_DIR}`, "dim");
  console.log();

  // Ensure logs dir exists
  if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });

  // Init client (auto-start server if needed)
  let client;
  let serverProcess = null;
  try {
    client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
    await client.session.list();
    log("Connected to OpenCode server.", "green");
  } catch (err) {
    log("OpenCode server not running. Starting it automatically...", "yellow");
    log(`Error was: ${err.message}`, "dim");

    serverProcess = spawn("opencode", ["serve"], {
      cwd: PROJECT_DIR,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const serverStartupLog = [];
    serverProcess.stdout.on("data", (d) => {
      const line = d.toString().trim();
      if (line) serverStartupLog.push(line);
    });
    serverProcess.stderr.on("data", (d) => {
      const line = d.toString().trim();
      if (line) serverStartupLog.push(line);
    });

    serverProcess.on("error", (e) => {
      log(`Failed to start opencode serve: ${e.message}`, "red");
      process.exit(1);
    });
    serverProcess.on("exit", (code) => {
      if (code && code !== 0) {
        log(`opencode serve exited with code ${code}`, "red");
      }
    });

    const SERVER_START_TIMEOUT = 60_000;
    const POLL = 1000;
    const start = Date.now();
    let connected = false;

    while (Date.now() - start < SERVER_START_TIMEOUT) {
      await sleep(POLL);
      try {
        client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
        await client.session.list();
        connected = true;
        break;
      } catch {
        process.stdout.write(".");
      }
    }
    console.log();

    if (!connected) {
      log("Failed to connect after starting opencode serve.", "red");
      log("Server log:", "dim");
      serverStartupLog.slice(-20).forEach((l) => console.log(c("dim", `  ${l}`)));
      log("\nTry running manually: opencode serve", "yellow");
      process.exit(1);
    }

    log("OpenCode server started and connected.", "green");
    log("Press Ctrl+C to stop. The server will be cleaned up on exit.", "dim");

    process.on("SIGINT", () => {
      log("\nShutting down...", "yellow");
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
      process.exit(130);
    });
    process.on("exit", () => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
    });
  }

  // Load or initialize state
  let state = loadState();

  // Auto-detect whether a previous run exists (tasks.json has entries)
  const existingTasks = safeReadJSON(PATHS.tasks, []);
  const hasPreviousRun = Array.isArray(existingTasks) && existingTasks.length > 0;

  if (retryMode || (!resumeMode && !verifyOnly && hasPreviousRun)) {
    // Retry mode — collect feedback then resume from appropriate phase
    // Triggered either by --retry flag OR automatically when a previous run is detected
    if (!retryMode) {
      log("Existing RALPH run detected. Switching to retry onboarding...", "yellow");
    }
    state = await runRetryOnboarding(client, state);
  } else if (verifyOnly) {
    state.phase = "verify";
    state.currentCycle = (state.currentCycle || 1);
  } else if (!resumeMode) {
    // Fresh run — reset state
    state = {
      phase: "plan",
      healCycles: 0,
      currentCycle: 1,
    };
    saveState(state);
  }

  log(`Starting at phase: ${state.phase}`, "cyan");

  // ---------------------------------------------------------------------------
  // Main state machine
  // ---------------------------------------------------------------------------

  while (state.phase !== "complete") {
    switch (state.phase) {
      case "plan":
        await runPlanPhase(client, state);
        break;

      case "implement":
        await runImplementPhase(client, state);
        break;

      case "verify": {
        const result = await runVerifyPhase(client, state);
        if (result.passed) {
          state.phase = "complete";
          saveState(state);
        } else {
          // Try to heal
          const canContinue = await runHealPhase(client, state);
          if (!canContinue) {
            // Max cycles reached
            printFinalReport(false, state);
            process.exit(1);
          }
          // After heal, go back to verify
          state.phase = "verify";
          saveState(state);
        }
        break;
      }

      default:
        log(`Unknown phase: ${state.phase}`, "red");
        process.exit(1);
    }
  }

  printFinalReport(true, state);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, "red");
  console.error(err);
  process.exit(1);
});
