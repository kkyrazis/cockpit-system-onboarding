#!/bin/bash
# Unit tests for invoke_status_hook() from common.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/packaging/systemd/scripts/common.sh"

PASS=0
FAIL=0

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  PASS: $label"
        PASS=$(( PASS + 1 ))
    else
        echo "  FAIL: $label — expected '$expected', got '$actual'"
        FAIL=$(( FAIL + 1 ))
    fi
}

assert_file_missing() {
    local label="$1" file="$2"
    if [ ! -f "$file" ]; then
        echo "  PASS: $label"
        PASS=$(( PASS + 1 ))
    else
        echo "  FAIL: $label — file '$file' should not exist"
        FAIL=$(( FAIL + 1 ))
    fi
}

assert_file_contains() {
    local label="$1" file="$2" expected="$3"
    if [ -f "$file" ] && grep -qF "$expected" "$file"; then
        echo "  PASS: $label"
        PASS=$(( PASS + 1 ))
    else
        echo "  FAIL: $label — file '$file' does not contain '$expected'"
        FAIL=$(( FAIL + 1 ))
    fi
}

# Set up temp directory
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Override config paths and hooks directory
ONBOARDING_USER_CONFIG="$TEST_DIR/user-config.json"
ONBOARDING_DEFAULT_CONFIG="$TEST_DIR/default-config.json"
ONBOARDING_HOOKS_DIR="$TEST_DIR/hooks.d"
mkdir -p "$ONBOARDING_HOOKS_DIR"

INVOCATION_LOG="$TEST_DIR/invocations.log"

# Helper: create a mock hook tool that logs its arguments
create_mock_hook() {
    local name="$1"
    cat > "$ONBOARDING_HOOKS_DIR/$name" <<'HOOKEOF'
#!/bin/bash
echo "$@" >> INVOCATION_LOG_PLACEHOLDER
HOOKEOF
    sed -i "s|INVOCATION_LOG_PLACEHOLDER|$INVOCATION_LOG|" "$ONBOARDING_HOOKS_DIR/$name"
    chmod 755 "$ONBOARDING_HOOKS_DIR/$name"
}

# ── Disabled in config → tool not invoked ──────────────────────────

echo "Disabled in config"

rm -f "$ONBOARDING_USER_CONFIG" "$ONBOARDING_DEFAULT_CONFIG" "$INVOCATION_LOG"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": false, "tool": "my-hook"}}
EOF
create_mock_hook "my-hook"

invoke_status_hook "ready" >/dev/null 2>&1
assert_file_missing "disabled: tool not invoked" "$INVOCATION_LOG"

# ── Enabled but tool name empty → exits cleanly ───────────────────

echo ""
echo "Enabled but tool name empty"

rm -f "$INVOCATION_LOG"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": ""}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
assert_file_missing "empty tool: not invoked" "$INVOCATION_LOG"

# ── Enabled but tool binary missing → graceful degradation ────────

echo ""
echo "Enabled but tool binary missing"

rm -f "$INVOCATION_LOG"
rm -f "$ONBOARDING_HOOKS_DIR/nonexistent"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "nonexistent"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
rc=$?
assert_eq "missing tool: returns 0" "0" "$rc"
assert_file_missing "missing tool: not invoked" "$INVOCATION_LOG"

# ── Enabled but tool not executable → graceful degradation ────────

echo ""
echo "Enabled but tool not executable"

rm -f "$INVOCATION_LOG"
echo '#!/bin/bash' > "$ONBOARDING_HOOKS_DIR/no-exec"
chmod 644 "$ONBOARDING_HOOKS_DIR/no-exec"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "no-exec"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
rc=$?
assert_eq "not executable: returns 0" "0" "$rc"
assert_file_missing "not executable: not invoked" "$INVOCATION_LOG"

# ── Enabled with valid tool → invoked with correct argument ───────

echo ""
echo "Enabled with valid tool"

rm -f "$INVOCATION_LOG"
create_mock_hook "good-hook"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "good-hook"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
assert_file_contains "valid tool: invoked with ready" "$INVOCATION_LOG" "ready"

# ── Tool exits non-zero → graceful degradation ───────────────────

echo ""
echo "Tool exits non-zero"

rm -f "$INVOCATION_LOG"
cat > "$ONBOARDING_HOOKS_DIR/fail-hook" <<'HOOKEOF'
#!/bin/bash
echo "$@" >> INVOCATION_LOG_PLACEHOLDER
exit 1
HOOKEOF
sed -i "s|INVOCATION_LOG_PLACEHOLDER|$INVOCATION_LOG|" "$ONBOARDING_HOOKS_DIR/fail-hook"
chmod 755 "$ONBOARDING_HOOKS_DIR/fail-hook"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "fail-hook"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
rc=$?
assert_eq "failing tool: returns 0" "0" "$rc"
assert_file_contains "failing tool: was still invoked" "$INVOCATION_LOG" "ready"

# ── Tool name contains / → rejected ──────────────────────────────

echo ""
echo "Tool name contains slash"

rm -f "$INVOCATION_LOG"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "sub/path"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
rc=$?
assert_eq "slash in name: returns 0" "0" "$rc"
assert_file_missing "slash in name: not invoked" "$INVOCATION_LOG"

# ── Tool name contains .. → rejected ─────────────────────────────

echo ""
echo "Tool name contains dot-dot"

rm -f "$INVOCATION_LOG"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "..evil"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
rc=$?
assert_eq "dot-dot in name: returns 0" "0" "$rc"
assert_file_missing "dot-dot in name: not invoked" "$INVOCATION_LOG"

# ── Symlink outside hooks.d → rejected ───────────────────────────

echo ""
echo "Symlink outside hooks.d"

rm -f "$INVOCATION_LOG"
echo '#!/bin/bash' > "$TEST_DIR/outside-script"
chmod 755 "$TEST_DIR/outside-script"
ln -sf "$TEST_DIR/outside-script" "$ONBOARDING_HOOKS_DIR/symlink-escape"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "symlink-escape"}}
EOF

invoke_status_hook "ready" >/dev/null 2>&1
rc=$?
assert_eq "symlink escape: returns 0" "0" "$rc"
assert_file_missing "symlink escape: not invoked" "$INVOCATION_LOG"

# ── All six states are passed correctly ──────────────────────────

echo ""
echo "All six states"

rm -f "$INVOCATION_LOG"
create_mock_hook "state-hook"
cat > "$ONBOARDING_USER_CONFIG" <<'EOF'
{"statusHook": {"enabled": true, "tool": "state-hook"}}
EOF

for state in ready in-progress applying success error off; do
    invoke_status_hook "$state" >/dev/null 2>&1
done
for state in ready in-progress applying success error off; do
    assert_file_contains "state $state logged" "$INVOCATION_LOG" "$state"
done

# ── Not enabled by default (no config) ───────────────────────────

echo ""
echo "Not enabled by default"

rm -f "$INVOCATION_LOG" "$ONBOARDING_USER_CONFIG" "$ONBOARDING_DEFAULT_CONFIG"

invoke_status_hook "ready" >/dev/null 2>&1
assert_file_missing "default config: not invoked" "$INVOCATION_LOG"

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
