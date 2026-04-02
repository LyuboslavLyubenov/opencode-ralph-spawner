# RALPH Loop

**RALPH** = **R**esearch → **A**rchitect → **L**aunch → **P**rove → **H**eal

A structured, multi-phase agentic development workflow using [OpenCode](https://opencode.ai) to orchestrate separate AI sessions for planning, implementation, and verification.

## Overview

The RALPH loop is a self-contained workflow that runs in a `ralph/` directory within your project. Each phase gets a fresh AI context — state travels through files, not conversation history.

```
Phase 0 — RETRY ONBOARDING (auto-triggered when a previous run is detected)
Phase 1 — PLAN      → Planner reads goals.md, searches codebase, writes plan.md + tasks.json
Phase 2 — LAUNCH    → Fresh agent spawns per task, implements, marks done
Phase 3 — PROVE     → Verifier runs commands, writes pass/fail report
Phase 4 — HEAL      → Fixes failed tasks, re-verifies (up to 10 cycles)
```

## Quick Start

```bash
cd ralph
npm install
node ralph.js
```

## Files

| File | Purpose |
|------|---------|
| `goals.md` | Task description and success criteria |
| `impl-criteria.md` | Implementation requirements per task |
| `verify-criteria.md` | Verification commands and expected results |
| `tasks.json` | Task list (populated by planner) |
| `plan.md` | Architecture/plan (written by planner) |
| `verification-report.md` | Pass/fail report from verifier |
| `ralph.js` | Orchestrator script |
| `logs/` | Session logs |

## Commands

```bash
node ralph.js          # Auto-detect: fresh start or retry
node ralph.js --resume # Resume interrupted run
node ralph.js --verify # Skip to verification phase
node ralph.js --retry  # Force retry onboarding
```

## Requirements

- Node.js 18+
- [OpenCode server](https://opencode.ai) running at `http://localhost:4096`
- OpenCode SDK (`@opencode-ai/sdk`)

## License

MIT
