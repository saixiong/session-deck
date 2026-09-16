#!/bin/sh
# A stand-in for the claude CLI used by the e2e suite: swallows the prompt on
# stdin and replays the result shape recorded from `claude -p --output-format
# json --json-schema` on 2026-09-14. FAKE_CLAUDE_FAIL=1 makes it fail the way
# a logged-out CLI does.
cat > /dev/null
if [ -n "$FAKE_CLAUDE_FAIL" ]; then
  printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","total_cost_usd":0,"duration_ms":50,"session_id":"x"}'
  exit 0
fi
sleep "${FAKE_CLAUDE_DELAY:-0}"
STRUCT='{"summary":"Fixing the login bug; PR #42 is open and waiting.","done":["Fixed the bug","Added a regression test"],"next_steps":["Merge PR #42"],"blockers":[],"priority":4,"priority_reason":"A PR is waiting on review.","completion":70,"completion_reason":"The fix and its test are in; the PR is not merged.","items":[{"text":"Merge PR #42","kind":"mechanical","effort":"small"}],"options":[{"id":"merge","label":"Merge the PR","description":"Land PR #42 once CI is green.","prompt":"Merge PR #42 and confirm CI passed."},{"id":"tests","label":"Add more tests","description":"Cover the logout path too.","prompt":"Add tests for the logout path."}]}'
ESC=$(printf '%s' "$STRUCT" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"result":"%s","structured_output":%s,"total_cost_usd":0.0031,"session_id":"cdd41434-a4c7-4d19-8a6f-b7f90d6de4ea","usage":{"input_tokens":931,"output_tokens":282}}\n' "$ESC" "$STRUCT"
