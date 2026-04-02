# Implementation Criteria — Agent Disobedience Trace Generator

## Task Structure

The planner should break the work into tasks by category batch. Each task covers 2-4 disobedience categories and generates all traces for those categories. The final task generates the catalog.

## Per-Task Implementation Criteria

### Trace File Requirements

For each trace JSON file:

1. **Valid JSON** — Must parse without errors
2. **Complete schema** — All fields present: `id`, `category`, `subcategory`, `title`, `description`, `severity`, `tags`, `conversation`, `analysis`
3. **Unique ID** — Format: `TRACE-{category_number}-{sequence_number}` (e.g., `TRACE-01-003`)
4. **Realistic conversation** — Each conversation must have:
   - A system message (if relevant to the scenario, otherwise omit)
   - At minimum 2 user messages and 2 assistant messages
   - At maximum 15 total messages
   - Natural, realistic dialogue — not wooden or obviously scripted
5. **Severity accuracy** — `low` (minor annoyance), `medium` (noticeable quality degradation), `high` (refusal to help), `critical` (safety vulnerability)
6. **Tags** — 2-5 descriptive tags per trace
7. **Analysis section** — Each of the 4 analysis fields must have 2-4 sentences of genuine insight
8. **Agent responses must be plausible** — Write them as if a real LLM generated them. Include hedging language, "I understand" preambles, typical refusal patterns, etc.

### Directory Structure

```
traces/
├── catalog.json
├── 01-content-filtering/
│   └── trace-001-*.json through trace-00N-*.json
├── 02-political-bias/
│   └── ...
├── 03-prompt-injection/
│   └── ...
├── 04-instruction-following/
│   └── ...
├── 05-safety-theater/
│   └── ...
├── 06-identity-role-confusion/
│   └── ...
├── 07-tone-policing/
│   └── ...
├── 08-asymmetric-cultural/
│   └── ...
├── 09-over-refusal-chaining/
│   └── ...
├── 10-capability-underclaiming/
│   └── ...
├── 11-preachy-moralizing/
│   └── ...
└── 12-selective-amnesia/
    └── ...
```

### Trace Count per Category

Minimum 3 traces per category (36 total minimum). Aim for 3-5 traces per category for a total of 36-60 traces.

### catalog.json Format

```json
{
  "title": "Agent Disobedience Trace Catalog",
  "generated_date": "YYYY-MM-DD",
  "total_traces": N,
  "categories": [
    {
      "id": "01-content-filtering",
      "name": "Content Filtering Overreach",
      "description": "...",
      "trace_count": N,
      "traces": [
        {
          "id": "TRACE-01-001",
          "file": "01-content-filtering/trace-001-medical-wound-care.json",
          "title": "...",
          "severity": "medium",
          "subcategory": "medical"
        }
      ]
    }
  ]
}
```

### Quality Criteria for Agent Responses

When writing agent (assistant) responses:

- **Use realistic refusal patterns**: "I'm not able to...", "I can't help with...", "As an AI...", "It's important to note that..."
- **Include hedging**: "While I understand your intent...", "I'd be happy to help with..."
- **Show gradual escalation** in multi-turn conversations (don't jump straight to refusal)
- **Vary the style** — some agents should be apologetic, some matter-of-fact, some preachy
- **Don't make all refusals identical** — variety in language and approach
- **Subtle cases should be genuinely hard to spot** — e.g., a response that technically answers but is clearly lower quality/effort than equivalent requests on the "approved" side

### Quality Criteria for User Messages

- Use varied user personas: student, researcher, writer, developer, curious person, professional
- Some users should be direct, others indirect
- Some users should push back after a refusal, others should accept it
- Include a mix of clearly-innocent requests and genuinely-borderline requests
- Some users should provide context explaining their legitimate need

### What Each Task Must Deliver

1. The category subdirectory created under `traces/`
2. All trace JSON files for the assigned categories
3. Each file committed to the plan

### Final Task (Catalog)

The last task in the plan must:
1. Scan all generated traces
2. Validate every JSON file
3. Generate `traces/catalog.json` with complete metadata
4. Report total counts and any issues found
