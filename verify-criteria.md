# Verification Criteria — Agent Disobedience Trace Generator

## Automated Checks

### 1. JSON Validity
- Every `.json` file in `traces/` (excluding catalog.json) must parse as valid JSON
- `traces/catalog.json` must parse as valid JSON
- Command: `find traces/ -name "*.json" -exec python3 -c "import json,sys; json.load(open(sys.argv[1]))" {} \;`

### 2. Schema Completeness
Each trace file must have all required top-level keys:
- `id`, `category`, `subcategory`, `title`, `description`, `severity`, `tags`, `conversation`, `analysis`

Each `analysis` object must have all 4 keys:
- `what_went_wrong`, `why_it_happened`, `expected_behavior`, `actual_behavior`

Each `conversation` entry must have `role` and `content`.

### 3. Severity Values
Only allowed: `low`, `medium`, `high`, `critical`

### 4. Role Values
Only allowed: `system`, `user`, `assistant`

### 5. Coverage Check
- All 12 category directories must exist under `traces/`
- Each category directory must contain at least 3 trace files
- Total trace count must be >= 36

### 6. No Duplicate IDs
- All trace `id` fields across all files must be unique

### 7. Conversation Length
- Each trace must have at least 2 user messages and 2 assistant messages
- Each trace must have no more than 15 total messages

### 8. Catalog Integrity
- `catalog.json` must list every trace file that exists
- Every file listed in catalog must actually exist on disk
- `total_traces` count in catalog must match actual file count
- Category trace counts must match

## Quality Checks (Manual / LLM-Assisted)

### 9. Realism Check
Spot-check 5-10 random traces:
- Do the agent responses sound like actual LLM output?
- Is the disobedience scenario plausible?
- Would this actually happen with a current-generation model?

### 10. Variety Check
- No two traces should have the same scenario
- User personas should vary across traces
- Agent response style should vary (not all identical refusal patterns)
- Mix of subtle and blatant disobedience across the collection

### 11. Analysis Quality
- Each analysis field should have substantive content (not just "the agent refused")
- `why_it_happened` should offer genuine hypothesis (e.g., RLHF overalignment, ambiguous training data, etc.)
- `expected_behavior` should be specific and actionable

### 12. Category Accuracy
- Traces in `01-content-filtering/` should actually be about content filtering
- Traces in `02-political-bias/` should actually demonstrate political bias
- No miscategorization

## Verification Command

```bash
# Run all automated checks
python3 -c "
import json, os, sys

errors = []
trace_dir = 'traces'
categories = [
    '01-content-filtering', '02-political-bias', '03-prompt-injection',
    '04-instruction-following', '05-safety-theater', '06-identity-role-confusion',
    '07-tone-policing', '08-asymmetric-cultural', '09-over-refusal-chaining',
    '10-capability-underclaiming', '11-preachy-moralizing', '12-selective-amnesia'
]

# Check directories exist
for cat in categories:
    path = os.path.join(trace_dir, cat)
    if not os.path.isdir(path):
        errors.append(f'Missing directory: {path}')

# Check traces
all_ids = []
total = 0
for cat in categories:
    cat_dir = os.path.join(trace_dir, cat)
    if not os.path.isdir(cat_dir):
        continue
    files = [f for f in os.listdir(cat_dir) if f.endswith('.json')]
    if len(files) < 3:
        errors.append(f'{cat}: only {len(files)} traces (need 3+)')
    for f in files:
        total += 1
        path = os.path.join(cat_dir, f)
        try:
            data = json.load(open(path))
            # Check required keys
            for key in ['id','category','subcategory','title','description','severity','tags','conversation','analysis']:
                if key not in data:
                    errors.append(f'{f}: missing key {key}')
            # Check analysis keys
            if 'analysis' in data:
                for ak in ['what_went_wrong','why_it_happened','expected_behavior','actual_behavior']:
                    if ak not in data['analysis']:
                        errors.append(f'{f}: missing analysis key {ak}')
            # Check severity
            if data.get('severity') not in ['low','medium','high','critical']:
                errors.append(f'{f}: invalid severity {data.get(\"severity\")}')
            # Check conversation
            conv = data.get('conversation', [])
            user_msgs = sum(1 for m in conv if m.get('role') == 'user')
            asst_msgs = sum(1 for m in conv if m.get('role') == 'assistant')
            if user_msgs < 2 or asst_msgs < 2:
                errors.append(f'{f}: need 2+ user and 2+ assistant msgs (got {user_msgs} user, {asst_msgs} assistant)')
            if len(conv) > 15:
                errors.append(f'{f}: too many messages ({len(conv)})')
            # Check ID uniqueness
            if data.get('id') in all_ids:
                errors.append(f'{f}: duplicate ID {data.get(\"id\")}')
            all_ids.append(data.get('id'))
        except json.JSONDecodeError as e:
            errors.append(f'{f}: invalid JSON - {e}')

# Check total
if total < 36:
    errors.append(f'Total traces: {total} (need 36+)')

# Check catalog
catalog_path = os.path.join(trace_dir, 'catalog.json')
if os.path.exists(catalog_path):
    catalog = json.load(open(catalog_path))
    if catalog.get('total_traces') != total:
        errors.append(f'Catalog total_traces ({catalog.get(\"total_traces\")}) != actual ({total})')
else:
    errors.append('Missing catalog.json')

if errors:
    print('FAILURES:')
    for e in errors:
        print(f'  - {e}')
    sys.exit(1)
else:
    print(f'ALL CHECKS PASSED ({total} traces)')
"
```

## Success Threshold

- All automated checks pass (exit code 0)
- No JSON validity errors
- No missing required fields
- All 12 categories covered with 3+ traces each
- Total 36+ traces
- Catalog is complete and accurate
