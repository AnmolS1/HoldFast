#!/usr/bin/env bash
# Secrets never reach the client bundle (T26 item 9). After `npm run build`:
#
#   bash scripts/security/bundle-secrets-check.sh                  dist/client against .dev.vars
#   bash scripts/security/bundle-secrets-check.sh --dir <d> --vars <file>
#   bash scripts/security/bundle-secrets-check.sh --self-test      the checks against planted fixtures
#
# (a) No Worker secret's NAME appears anywhere under the bundle directory. `SENTRY_DSN` is matched
#     only as a whole name, so the public browser DSN's name `SENTRY_DSN_WEB` does not count.
# (b) No VALUE of those secrets, as the vars file holds them, appears there either. Values are
#     handed to grep through a file descriptor, never on a command line, and are never printed:
#     only the key name of a value that was found. A vars file that does not exist skips (b), and
#     says so (CI builds have none).
# Public by nature, never checked: GOOGLE_CLIENT_ID, TURNSTILE_SITEKEY, SENTRY_DSN_WEB.
# Exit 0 = clean, 1 = something found, 2 = usage.

set -euo pipefail

SECRET_NAMES=(
  BETTER_AUTH_SECRET
  FILES_TOKEN_SECRET
  IP_ENC_KEY
  RESEND_API_KEY
  GOOGLE_CLIENT_SECRET
  TURNSTILE_SECRET
  SENTRY_DSN
  ADMIN_EMAILS
  CF_ANALYTICS_TOKEN
  PHOTODNA_SUBSCRIPTION_KEY
)
# Shorter values are too likely to occur by chance in minified code to mean anything.
MIN_VALUE_LENGTH=8

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# A name counts only whole: not preceded or followed by a character that could continue an
# identifier. (Written out instead of \b, whose meaning differs between BSD and GNU grep.)

# The one occurrence of a name that is known and harmless: Better Auth's env accessor
# (@better-auth/core dist/env/env-impl.mjs, `get BETTER_AUTH_SECRET() { return getEnvVar("…") }`),
# which the shared auth code pulls into the client. In the browser build `process.env` is replaced
# by `{}`, so it reads nothing. Exactly that minified shape is set aside — the getter, a call of one
# identifier with the same name as a template literal — and every other occurrence still fails.
allowed_accessor() { # <name> → an ERE for the accessor of that name
  printf 'get %s\(\)\{return [A-Za-z0-9_$]+\(`%s`\)\}' "$1" "$1"
}

# check_names <dir> → prints each name found and the file; returns 1 if any.
check_names() {
  local dir="$1" found=0 name file total allowed
  for name in "${SECRET_NAMES[@]}"; do
    while IFS= read -r file; do
      [ -z "$file" ] && continue
      total="$(grep -oE "(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)" "$file" | wc -l | tr -d ' ')"
      # An accessor holds the name twice.
      allowed="$(grep -oE "$(allowed_accessor "$name")" "$file" | wc -l | tr -d ' ')"
      if [ "$total" -gt $((allowed * 2)) ]; then
        found=1
        echo "bundle-secrets: the secret NAME $name is in ${file#"$dir"/}"
      elif [ "$allowed" -gt 0 ]; then
        echo "bundle-secrets: ${file#"$dir"/}: Better Auth's env accessor for $name only (reads {} in a browser) — allowed"
      fi
    done <<<"$(grep -rlE "(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)" "$dir" 2>/dev/null || true)"
  done
  return "$found"
}

# value_of <vars file> <key> → the value (quotes removed), on stdout. Never echoed elsewhere.
value_of() {
  local file="$1" key="$2" line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" | tail -n 1 || true)"
  [ -z "$line" ] && return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "$value"
}

# check_values <dir> <vars file> → prints the KEY of each value found; returns 1 if any.
check_values() {
  local dir="$1" vars="$2" found=0 checked=0 short=0 key value
  if [ ! -f "$vars" ]; then
    echo "bundle-secrets: no vars file at $vars — the value check (b) is skipped"
    return 0
  fi
  for key in "${SECRET_NAMES[@]}"; do
    value="$(value_of "$vars" "$key")"
    [ -z "$value" ] && continue
    if [ "${#value}" -lt "$MIN_VALUE_LENGTH" ]; then
      short=$((short + 1))
      continue
    fi
    checked=$((checked + 1))
    # -F: the value is a literal; -f: it arrives through a descriptor, not argv.
    if grep -rqF -f <(printf '%s\n' "$value") "$dir" 2>/dev/null; then
      echo "bundle-secrets: the VALUE of $key is in the bundle (not printed)"
      found=1
    fi
  done
  echo "bundle-secrets: $checked secret value(s) checked, $short too short to check"
  return "$found"
}

run() {
  local dir="$1" vars="$2" status=0
  if [ ! -d "$dir" ]; then
    echo "bundle-secrets: $dir does not exist — run npm run build first"
    return 2
  fi
  check_names "$dir" || status=1
  check_values "$dir" "$vars" || status=1
  if [ "$status" = 0 ]; then echo "bundle-secrets: clean ($dir)"; fi
  return "$status"
}

# ── self-test: every outcome on a planted fixture (all values made up for this test) ─────────
self_test() {
  local tmp failures=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/clean/assets" "$tmp/name/assets" "$tmp/dsn/assets" "$tmp/value/assets" "$tmp/public/assets"
  cat >"$tmp/vars" <<'VARS'
BETTER_AUTH_SECRET="made-up-auth-secret-0123456789"
FILES_TOKEN_SECRET=made-up-files-secret-0123456789
SENTRY_DSN=
TURNSTILE_SITEKEY=1x00000000000000000000AA
ADMIN_EMAILS=x
VARS
  printf 'const a=1;export{a};\n' >"$tmp/clean/assets/index.js"
  printf 'console.log("BETTER_AUTH_SECRET")\n' >"$tmp/name/assets/index.js"
  printf 'const k=env.SENTRY_DSN;\n' >"$tmp/dsn/assets/index.js"
  printf 'const t="xx made-up-files-secret-0123456789 yy";\n' >"$tmp/value/assets/index.js"
  # The public DSN's name, the public site key and the one-character value: none of them counts.
  printf 'const d=cfg.SENTRY_DSN_WEB,s="1x00000000000000000000AA",x="x";\n' >"$tmp/public/assets/index.js"
  mkdir -p "$tmp/accessor/assets" "$tmp/accessor-plus/assets"
  # Better Auth's env accessor, as the minifier writes it: allowed. The same file with one more use: not.
  printf 'Object.freeze({get BETTER_AUTH_SECRET(){return oV(`BETTER_AUTH_SECRET`)},get X(){}});\n' >"$tmp/accessor/assets/index.js"
  printf 'Object.freeze({get BETTER_AUTH_SECRET(){return oV(`BETTER_AUTH_SECRET`)}});send(BETTER_AUTH_SECRET);\n' >"$tmp/accessor-plus/assets/index.js"

  expect() { # <label> <expected status> <dir>
    local label="$1" want="$2" got=0
    run "$tmp/$3" "$tmp/vars" >"$tmp/out" 2>&1 || got=$?
    if [ "$got" = "$want" ] && ! grep -qF "made-up-" "$tmp/out"; then
      echo "self-test: ok   $label (exit $got)"
    else
      echo "self-test: FAIL $label (exit $got, wanted $want; output follows)"
      sed 's/^/    /' "$tmp/out"
      failures=$((failures + 1))
    fi
  }
  expect "a clean bundle passes" 0 clean
  expect "a secret's name fails" 1 name
  expect "SENTRY_DSN as a whole name fails" 1 dsn
  expect "a planted secret value fails (and is not printed)" 1 value
  expect "SENTRY_DSN_WEB, the site key and a short value pass" 0 public
  expect "Better Auth's env accessor alone passes" 0 accessor
  expect "the accessor plus another use of the name fails" 1 accessor-plus
  return "$failures"
}

dir="$root/dist/client"
vars="$root/.dev.vars"
case "${1:-}" in
  --self-test)
    self_test
    exit $?
    ;;
  "") ;;
  *)
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) dir="$2"; shift 2 ;;
        --vars) vars="$2"; shift 2 ;;
        *) echo "usage: $0 [--dir <bundle dir>] [--vars <vars file>] | --self-test" >&2; exit 2 ;;
      esac
    done
    ;;
esac
run "$dir" "$vars"
