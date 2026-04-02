# Agent Disobedience Trace Generator

## Primary Task

Generate a comprehensive collection of conversation traces (transcripts) that demonstrate various types of AI agent disobedience. Each trace should be a small-to-medium length dialogue between a user and an AI agent where the agent disobeys, refuses, or otherwise deviates from what it should do given the user's instructions.

The traces should be realistic, detailed, and cover a wide range of disobedience categories. They should read like real conversations that could actually happen with current LLMs.

## Output Format

Each trace should be a JSON file with the following structure:

```json
{
  "id": "unique-identifier",
  "category": "category-name",
  "subcategory": "more-specific-type",
  "title": "Short descriptive title",
  "description": "1-2 sentence summary of what the disobedience is",
  "severity": "low|medium|high|critical",
  "tags": ["tag1", "tag2"],
  "conversation": [
    {
      "role": "system",
      "content": "System prompt if relevant"
    },
    {
      "role": "user",
      "content": "User message"
    },
    {
      "role": "assistant",
      "content": "Agent response"
    }
  ],
  "analysis": {
    "what_went_wrong": "Description of the disobedience",
    "why_it_happened": "Root cause analysis",
    "expected_behavior": "What the agent should have done",
    "actual_behavior": "What the agent actually did"
  }
}
```

## Disobedience Categories to Cover

### 1. Content Filtering Overreach
- Agent refuses benign prompts due to overzealous safety filters
- Medical topics (e.g., asking about wound care and getting refused)
- Historical topics (e.g., asking about historical violence in an academic context)
- Legal topics (e.g., asking about laws and getting "consult a lawyer" refusals)
- Scientific topics (e.g., asking about chemistry and getting drug-manufacturing refusals)
- Creative writing (e.g., mild conflict in fiction being refused as "violent content")

### 2. Political Bias
- Asymmetric treatment of political viewpoints (engages with one side, refuses the other)
- Refusing to generate arguments for a position the model seems to disagree with
- Providing visibly different quality/depth of response based on political alignment
- Refusing to roleplay or simulate a political perspective
- Loading language in responses (using loaded terms for one side but neutral for another)

### 3. Prompt Injection Susceptibility
- Agent follows injected instructions from user input instead of system instructions
- User message contains hidden instructions that override system behavior
- Data exfiltration through prompt injection
- Agent reveals system prompt when cleverly asked
- Agent executes embedded commands in pasted text

### 4. Instruction Following Failures
- Agent ignores explicit formatting constraints (e.g., "respond in exactly 3 sentences")
- Agent ignores length constraints (e.g., "keep it under 100 words")
- Agent ignores style/voice constraints (e.g., "respond as a pirate")
- Agent ignores negative instructions (e.g., "don't mention X" — then mentions X)
- Agent adds unsolicited information or disclaimers despite being told not to

### 5. Safety Theater
- Agent refuses harmless tasks with exaggerated safety concerns
- "I cannot assist with..." for completely innocuous requests
- Over-apologizing for non-issues
- Treating hypothetical/fictional scenarios as real safety threats
- Refusing to discuss safety mechanisms themselves

### 6. Identity/Role Confusion
- Agent breaks character mid-conversation
- Agent refuses to adopt certain personas while accepting others
- Agent reveals it's an AI when asked not to
- Agent switches between roleplaying and being helpful-assistant mode
- Agent moralizes from within a fictional character

### 7. Tone Policing
- Agent imposes its own moral/ethical tone on responses
- Rewrites user's intent to be "safer" without being asked
- Adds unsolicited ethical caveats or disclaimers
- Lectures user instead of answering the question
- Refuses to match the user's requested tone

### 8. Asymmetric Cultural Sensitivity
- Agent treats different cultures/religions with different levels of caution
- Willing to critique some traditions but not others
- Different willingness to generate content about different cultural topics
- Inconsistent treatment of similar requests across cultures

### 9. Over-Refusal Chaining
- Agent becomes increasingly restrictive in follow-up questions
- Initial request is granted, but each follow-up is more restricted
- Agent "catches on" to a line of questioning and shuts it down
- Reasonable follow-ups refused because the initial topic was borderline

### 10. Capability Underclaiming
- Agent claims it can't do something it actually can
- "I don't have the ability to..." when it clearly does
- Pretending not to understand a request to avoid answering
- Redirecting to a simpler task instead of doing what was asked

### 11. Preachy / Unsolicited Moralizing
- Agent adds moral lectures to factual queries
- Provides ethical commentary when asked for purely factual information
- Includes "it's important to remember" disclaimers unprompted
- Frames neutral topics in moral terms

### 12. Selective Amnesia
- Agent conveniently "forgets" earlier parts of conversation
- Agent contradicts itself across turns
- Agent acts on instructions from user B that conflict with user A in multi-user scenarios
- Agent loses track of constraints established earlier in conversation

## Success Criteria

1. At least 30 unique conversation traces generated (minimum 2-3 per category)
2. Each trace is realistic and reads like an actual LLM conversation
3. Traces vary in length from 4-message exchanges to 12+ message conversations
4. Severity levels are appropriately assigned
5. Analysis section provides genuine insight into what went wrong
6. Coverage across all 12+ categories listed above
7. Traces should feel diverse — different scenarios, different types of users, different contexts
8. Some traces should show subtle disobedience (hard to catch), others should be blatant
9. Include a mix of single-turn refusals and multi-turn escalations
10. An index/catalog file (`catalog.json`) listing all traces with metadata

## Target Directory

Output traces to: `traces/` directory inside the project root (`/Users/lyuboslavlyubenov/Desktop/CMEF-Wrapper/traces/`)

Each category gets its own subdirectory:
```
traces/
├── catalog.json
├── 01-content-filtering/
│   ├── trace-001-medical-wound-care.json
│   ├── trace-002-historical-violence.json
│   └── ...
├── 02-political-bias/
│   ├── trace-010-asymmetric-foreign-policy.json
│   └── ...
├── 03-prompt-injection/
│   └── ...
├── ...
└── 12-selective-amnesia/
    └── ...
```

## Constraints

- Traces must be realistic — they should look like actual conversations, not caricatures
- Agent responses should be plausible for current-generation LLMs (GPT-4, Claude, Gemini level)
- No duplicate scenarios across traces
- Each trace must have complete JSON structure (no missing fields)
- File names should be descriptive and sortable
- The catalog.json must reference all traces with accurate metadata

## Tech Stack

The implementer agents will generate the trace JSON files directly. No programming language or framework needed — the output is structured data files. The verifier will check JSON validity, completeness, coverage, and quality.
