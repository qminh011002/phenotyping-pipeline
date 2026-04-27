#!/usr/bin/env bash
# FS-013 — Auth + per-user batch ownership E2E.
#
# Self-contained scripted run against a local backend. Designed to be re-runnable
# (each run uses a unique email suffix). Exits non-zero on the first failure.
#
# Usage:
#   BASE=http://127.0.0.1:8000 ./fs013_smoke.sh
#
# Requires: bash, curl, python3.

set -u
BASE="${BASE:-http://127.0.0.1:8000}"
T="$(date +%s)"
PASS_COUNT=0
FAIL_COUNT=0
FAILED_NAMES=()

# ── helpers ────────────────────────────────────────────────────────────────────

_extract_field() {
  # _extract_field <json> <field>
  printf '%s' "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['$2'])" 2>/dev/null || true
}

# Run a curl call, capturing body and HTTP status. Sets globals BODY and CODE.
_call() {
  local body
  body="$(curl -sS -w $'\n__HTTP__%{http_code}' "$@")"
  CODE="${body##*__HTTP__}"
  BODY="${body%$'\n__HTTP__'*}"
}

_expect_status() {
  # _expect_status <name> <expected>
  local name="$1" expected="$2"
  if [[ "$CODE" == "$expected" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  ✓ [$name] HTTP $CODE"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_NAMES+=("$name")
    echo "  ✗ [$name] expected HTTP $expected, got $CODE"
    echo "    body: $BODY" | head -c 300
    echo
  fi
}

_expect_code() {
  # _expect_code <name> <error_code>  — checks JSON detail.code
  local name="$1" expected="$2"
  local got
  got="$(printf '%s' "$BODY" | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except: print(''); sys.exit(0)
det=d.get('detail') if isinstance(d.get('detail'),dict) else {}
print(det.get('code',''))" 2>/dev/null)"
  if [[ "$got" == "$expected" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  ✓ [$name] code=$got"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_NAMES+=("$name")
    echo "  ✗ [$name] expected code=$expected, got '$got'"
    echo "    body: $BODY" | head -c 300
    echo
  fi
}

echo "FS-013 — auth + ownership E2E"
echo "BASE=$BASE  emails suffixed -$T"
echo

# ── Section A — register, login, /auth/me ──────────────────────────────────────

echo "── A. register / login / me"

_call -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"alice-$T@x.com\",\"password\":\"hunter22long\",\"name\":\"Alice\"}"
_expect_status "alice register" "201"
ALICE_ACCESS="$(_extract_field "$BODY" "access_token")"
ALICE_REFRESH="$(_extract_field "$BODY" "refresh_token")"

_call -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"bob-$T@x.com\",\"password\":\"hunter22long\",\"name\":\"Bob\"}"
_expect_status "bob register" "201"
BOB_ACCESS="$(_extract_field "$BODY" "access_token")"
BOB_REFRESH="$(_extract_field "$BODY" "refresh_token")"

_call -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"alice-$T@x.com\",\"password\":\"hunter22long\",\"name\":\"Alice\"}"
_expect_status "duplicate register → 409" "409"
_expect_code "duplicate register code" "email_taken"

_call -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"alice-$T@x.com\",\"password\":\"WRONG\"}"
_expect_status "wrong password → 401" "401"
_expect_code "wrong password code" "invalid_credentials"

_call "$BASE/auth/me" -H "Authorization: Bearer $ALICE_ACCESS"
_expect_status "/auth/me with valid token" "200"

_call "$BASE/auth/me" -H "Authorization: Bearer not-a-jwt"
_expect_status "/auth/me with garbage → 401" "401"
_expect_code "garbage token code" "token_invalid"

# ── Section B — Alice creates a batch, ownership enforced ──────────────────────

echo
echo "── B. cross-user ownership"

_call -X POST "$BASE/analyses" -H "Authorization: Bearer $ALICE_ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"organism_type":"egg","mode":"upload","device":"cpu","total_image_count":1,"name":"alice-batch","classes":["egg"]}'
_expect_status "alice create batch" "201"
BID="$(_extract_field "$BODY" "id")"
ALICE_USER_ID="$(_extract_field "$BODY" "user_id")"
echo "    batch_id=$BID  alice user_id=$ALICE_USER_ID"

_call "$BASE/analyses" -H "Authorization: Bearer $ALICE_ACCESS"
_expect_status "alice list batches" "200"
ALICE_TOTAL="$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])')"
if [[ "$ALICE_TOTAL" == "1" ]]; then
  PASS_COUNT=$((PASS_COUNT + 1)); echo "  ✓ [alice list count == 1]"
else
  FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_NAMES+=("alice list count"); echo "  ✗ [alice list count] got $ALICE_TOTAL"
fi

_call "$BASE/analyses" -H "Authorization: Bearer $BOB_ACCESS"
_expect_status "bob list" "200"
BOB_TOTAL="$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])')"
if [[ "$BOB_TOTAL" == "0" ]]; then
  PASS_COUNT=$((PASS_COUNT + 1)); echo "  ✓ [bob list empty]"
else
  FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_NAMES+=("bob list empty"); echo "  ✗ [bob list empty] got $BOB_TOTAL"
fi

_call "$BASE/analyses/$BID" -H "Authorization: Bearer $BOB_ACCESS"
_expect_status "bob GET alice's batch → 404" "404"

_call -X PATCH "$BASE/analyses/$BID" -H "Authorization: Bearer $BOB_ACCESS" \
  -H 'Content-Type: application/json' -d '{"name":"hijacked"}'
_expect_status "bob PATCH alice's batch → 404" "404"

_call -X DELETE "$BASE/analyses/$BID" -H "Authorization: Bearer $BOB_ACCESS"
_expect_status "bob DELETE alice's batch → 404" "404"

_call "$BASE/inference/results/$BID/anything/overlay.png" -H "Authorization: Bearer $BOB_ACCESS"
_expect_status "bob overlay on alice's batch → 404" "404"

_call "$BASE/analyses"
_expect_status "unauthenticated /analyses → 401" "401"
_expect_code "unauthenticated code" "token_invalid"

_call "$BASE/dashboard/stats" -H "Authorization: Bearer $ALICE_ACCESS"
_expect_status "alice dashboard" "200"
_call "$BASE/dashboard/stats" -H "Authorization: Bearer $BOB_ACCESS"
_expect_status "bob dashboard" "200"
BOB_RECENT_LEN="$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["recent_analyses"]))')"
if [[ "$BOB_RECENT_LEN" == "0" ]]; then
  PASS_COUNT=$((PASS_COUNT + 1)); echo "  ✓ [bob dashboard recent empty]"
else
  FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_NAMES+=("bob dashboard recent empty"); echo "  ✗ [bob dashboard recent empty] got $BOB_RECENT_LEN"
fi

# ── Section C — refresh / rotation / revocation ───────────────────────────────

echo
echo "── C. refresh + revocation"

_call -X POST "$BASE/auth/refresh" \
  -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$ALICE_REFRESH\"}"
_expect_status "alice refresh → 200" "200"
NEW_REFRESH="$(_extract_field "$BODY" "refresh_token")"

_call -X POST "$BASE/auth/refresh" \
  -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$ALICE_REFRESH\"}"
_expect_status "reuse OLD refresh → 401" "401"
_expect_code "reuse old refresh code" "token_revoked"

_call -X POST "$BASE/auth/refresh" \
  -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$ALICE_ACCESS\"}"
_expect_status "access used as refresh → 401" "401"
_expect_code "access-as-refresh code" "token_invalid"

_call -X POST "$BASE/auth/logout" \
  -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$NEW_REFRESH\"}"
_expect_status "alice logout → 204" "204"

_call -X POST "$BASE/auth/refresh" \
  -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$NEW_REFRESH\"}"
_expect_status "refresh after logout → 401" "401"
_expect_code "refresh-after-logout code" "token_revoked"

_call -X POST "$BASE/auth/logout" \
  -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$NEW_REFRESH\"}"
_expect_status "logout idempotent → 204" "204"

# ── Section D — alice cleans up own batch ─────────────────────────────────────

echo
echo "── D. owner can mutate own data"

_call -X PATCH "$BASE/analyses/$BID" -H "Authorization: Bearer $BOB_ACCESS" \
  -H 'Content-Type: application/json' -d '{"name":"after-logout"}'
_expect_status "bob PATCH still 404" "404"

# Alice needs a fresh access token (she logged out above). Login again.
_call -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"alice-$T@x.com\",\"password\":\"hunter22long\"}"
_expect_status "alice re-login" "200"
ALICE_ACCESS2="$(_extract_field "$BODY" "access_token")"

_call -X PATCH "$BASE/analyses/$BID" -H "Authorization: Bearer $ALICE_ACCESS2" \
  -H 'Content-Type: application/json' -d '{"name":"alice-renamed"}'
_expect_status "alice PATCH own batch → 200" "200"

_call -X DELETE "$BASE/analyses/$BID" -H "Authorization: Bearer $ALICE_ACCESS2"
_expect_status "alice DELETE own batch → 204" "204"

# ── Summary ───────────────────────────────────────────────────────────────────

echo
echo "──"
echo "PASS: $PASS_COUNT"
echo "FAIL: $FAIL_COUNT"
if (( FAIL_COUNT > 0 )); then
  echo "FAILED scenarios:"
  for n in "${FAILED_NAMES[@]}"; do echo "  - $n"; done
  exit 1
fi
exit 0
