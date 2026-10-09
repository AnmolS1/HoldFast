#!/usr/bin/env bash
# Shared checks for the deploy workflows and scripts/verify-gate-a.sh. One implementation of each
# rule, so the workflows and the gate cannot drift apart.
#
#   deploy-lib.sh dev-vars [root] [port]             write a CI .dev.vars with fresh generated secrets
#   deploy-lib.sh built-env <dev|production> [file]  which environment did the last build emit?
#   deploy-lib.sh stamp <base-url> <sha> [tries] [sleep]   GET /__meta commit == sha
#   deploy-lib.sh health <base-url>                  GET /api/health is 200 {"ok":true}
#   deploy-lib.sh files-host <url> [tries] [sleep]   GET is the Worker's bare 404 (exit 0/10/11/12, see below)
#   deploy-lib.sh branch-head <branch> <sha>         sha is still the head of origin/<branch>
#   deploy-lib.sh containers-plan <base-url> <sha>   build the scanner image, or leave containers alone?
#   deploy-lib.sh worker-ready <worker>              the Worker exists, has a deployment and its secrets
#   deploy-lib.sh secrets <worker>                   the Worker has the nine secret names
#   deploy-lib.sh utc-zone                           the database in DATABASE_URL_DIRECT keeps UTC time
#   deploy-lib.sh migrate <apply|none-pending> <local|remote>   utc-zone, then drizzle migrations, counted
#   deploy-lib.sh self-test                          every evaluator fails on bad input, passes on good
#   deploy-lib.sh utc-zone-self-test                 utc-zone against a LOCAL Postgres: UTC passes, others fail
#
# Rules for every command here: exit non-zero unless the thing was actually observed and matched (a
# check that could not run is a failure, never a pass); print what was compared; never print a
# secret value. Runs on bash 3.2 (macOS) and bash 5 (runners).
set -euo pipefail

export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$lib_dir/../../.." && pwd)"

REQUIRED_SECRETS="ADMIN_EMAILS BETTER_AUTH_SECRET FILES_TOKEN_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET IP_ENC_KEY RESEND_API_KEY SENTRY_DSN TURNSTILE_SECRET"
# Cloudflare's published always-pass Turnstile test sitekey (not a secret).
TURNSTILE_TEST_SITEKEY="1x00000000000000000000AA"
# drizzle-kit's default bookkeeping table (drizzle.config.ts sets no `migrations` block).
MIGRATIONS_TABLE="drizzle.__drizzle_migrations"
MIGRATIONS_JOURNAL="drizzle/meta/_journal.json"

fail() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::error::%s\n' "$*"; fi
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool not found: $tool"
  done
}

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# Everything from the first line that opens a JSON value (CLIs print banners first).
json_tail() { awk 'found || /^[[:space:]]*[\[{]/ { found = 1; print }'; }

# Replace anything that looks like a database URL. Applied to all migrate and psql output.
redact() { sed -E 's#postgres(ql)?://[^[:space:]"'"'"']+#<database-url>#g'; }

# ── dev-vars ─────────────────────────────────────────────────────────────────────────────────────
# Writes <root>/.dev.vars for the e2e job: scripts/dev-env.sh does the writing (example file →
# Turnstile test pair, memory mail, scan stub, mode 600); this adds the three generated secrets the
# example leaves blank, through a temp source file that never touches a command line or the log.
cmd_dev_vars() {
  local root="${1:-$repo_root}" port="${2:-5173}"
  need openssl awk
  [ -x "$root/scripts/dev-env.sh" ] || fail "dev-vars: $root/scripts/dev-env.sh is missing or not executable"
  [ -f "$root/.dev.vars.example" ] || fail "dev-vars: $root/.dev.vars.example is missing"
  # A checkout that already has a .dev.vars holds somebody's local secrets: never replace them.
  [ ! -e "$root/.dev.vars" ] || fail "dev-vars: $root/.dev.vars already exists; refusing to overwrite it (this command is for a fresh CI checkout)"

  local src
  src="$(umask 077 && mktemp "${TMPDIR:-/tmp}/holdfast-ci-vars.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -f '$src'" EXIT
  # 48 random bytes for the two HMAC/HKDF roots; 32 for IP_ENC_KEY (.dev.vars.example: an AES-256 key).
  {
    printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
    printf 'FILES_TOKEN_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
    printf 'IP_ENC_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')"
  } >"$src"

  "$root/scripts/dev-env.sh" "$port" "$src" >/dev/null
  rm -f "$src"
  trap - EXIT

  local target="$root/.dev.vars"
  [ -f "$target" ] || fail "dev-vars: scripts/dev-env.sh wrote no .dev.vars"
  local mode
  mode="$(stat -c '%a' "$target" 2>/dev/null || stat -f '%Lp' "$target")"
  [ "$mode" = "600" ] || fail "dev-vars: .dev.vars has mode $mode, expected 600"

  # Lengths only. awk reads the file; no value reaches argv, the environment or stdout.
  local report
  report="$(awk -v sitekey="$TURNSTILE_TEST_SITEKEY" -v port="$port" '
    function val(line) { return substr(line, index(line, "=") + 1) }
    /^BETTER_AUTH_SECRET=/ { a = val($0) }
    /^FILES_TOKEN_SECRET=/ { b = val($0) }
    /^IP_ENC_KEY=/         { c = val($0) }
    /^TURNSTILE_SITEKEY=/  { site = val($0) }
    /^EMAIL_TRANSPORT=/    { mail = val($0) }
    /^SCAN_STUB=/          { stub = val($0) }
    /^APP_ORIGIN=/         { origin = val($0) }
    /^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|RESEND_API_KEY|SENTRY_DSN)=/ { if (val($0) != "") filled++ }
    END {
      printf "BETTER_AUTH_SECRET length=%d\nFILES_TOKEN_SECRET length=%d\nIP_ENC_KEY length=%d\n", length(a), length(b), length(c)
      ok = 1
      if (length(a) < 64 || length(b) < 64 || length(c) < 44) { print "BAD a generated secret is empty or short"; ok = 0 }
      if (a == b || a == c || b == c) { print "BAD two generated secrets are identical"; ok = 0 }
      if (site != sitekey) { print "BAD TURNSTILE_SITEKEY is not the published test key"; ok = 0 }
      if (mail != "memory") { print "BAD EMAIL_TRANSPORT is not memory"; ok = 0 }
      if (stub != "1") { print "BAD SCAN_STUB is not 1"; ok = 0 }
      if (origin != "http://localhost:" port) { print "BAD APP_ORIGIN does not name port " port; ok = 0 }
      if (filled > 0) { print "BAD a third-party secret is filled in (must stay blank in CI)"; ok = 0 }
      print (ok ? "OK" : "NOT-OK")
    }' "$target")"
  printf '%s\n' "$report" | grep -v '^OK$' || true
  [ "$(printf '%s\n' "$report" | tail -n 1)" = "OK" ] || fail "dev-vars: the written .dev.vars is not what the e2e job needs"
  echo "dev-vars: wrote .dev.vars for port $port (mode 600; three generated secrets, Turnstile test pair, memory mail, scan stub)"
}

# ── built-env ────────────────────────────────────────────────────────────────────────────────────
# The build output directory is dist/holdfast_dev/ for EVERY environment; only the emitted config
# says which one was built. Asserts name, routes and resources, so a production build can never
# be deployed as dev or the reverse.
eval_built_env() {
  local env="$1" file="$2" name routes bucket queue hyperdrive senv app files
  case "$env" in
    dev)
      name="holdfast-dev" routes="dev.holdfastusercontent.com holdfast-dev.ponderance.dev"
      bucket="holdfast-files-dev" queue="holdfast-scan-dev" senv="dev"
      hyperdrive="097127f66b124f61abf6e7f5d26925ec"
      app="https://holdfast-dev.ponderance.dev" files="https://dev.holdfastusercontent.com"
      ;;
    production)
      name="holdfast" routes="holdfast.ponderance.dev holdfastusercontent.com"
      bucket="holdfast-files" queue="holdfast-scan" senv="production"
      hyperdrive="e899309ce0d543bb99bd09fa582aac90"
      app="https://holdfast.ponderance.dev" files="https://holdfastusercontent.com"
      ;;
    *) echo "built-env: environment must be 'dev' or 'production', got '$env'" && return 1 ;;
  esac
  [ -s "$file" ] || { echo "built-env: $file does not exist or is empty (no build ran)" && return 1; }
  jq -e . "$file" >/dev/null 2>&1 || { echo "built-env: $file is not JSON" && return 1; }

  local bad=0 got
  check() { # label expected actual
    if [ "$2" = "$3" ]; then
      echo "built-env: $1 = $3"
    else
      echo "built-env: MISMATCH $1: expected '$2', emitted '$3'"
      bad=1
    fi
  }
  got="$(jq -r '.name // ""' "$file")"
  check "name" "$name" "$got"
  got="$(jq -r '[.routes[]? | if type == "object" then .pattern else . end] | sort | join(" ")' "$file")"
  check "routes" "$routes" "$got"
  got="$(jq -r '[.routes[]? | if type == "object" then (.custom_domain // false) else false end] | all | tostring' "$file")"
  check "routes are custom domains" "true" "$got"
  got="$(jq -r '[.r2_buckets[]?.bucket_name] | join(" ")' "$file")"
  check "r2 bucket" "$bucket" "$got"
  got="$(jq -r '[.queues.producers[]?.queue] | join(" ")' "$file")"
  check "queue producer" "$queue" "$got"
  got="$(jq -r '[.hyperdrive[]?.id] | join(" ")' "$file")"
  check "hyperdrive id" "$hyperdrive" "$got"
  got="$(jq -r '.vars.SENTRY_ENVIRONMENT // ""' "$file")"
  check "vars.SENTRY_ENVIRONMENT" "$senv" "$got"
  got="$(jq -r '.vars.APP_ORIGIN // ""' "$file")"
  check "vars.APP_ORIGIN" "$app" "$got"
  got="$(jq -r '.vars.FILES_ORIGIN // ""' "$file")"
  check "vars.FILES_ORIGIN" "$files" "$got"
  # A deployed Worker never uses the memory mail transport (it would expose the test outbox).
  got="$(jq -r '.vars.EMAIL_TRANSPORT // ""' "$file")"
  check "vars.EMAIL_TRANSPORT" "resend" "$got"
  if [ "$env" = "production" ]; then
    got="$(jq -r '.vars.SCAN_STUB // ""' "$file")"
    check "vars.SCAN_STUB" "0" "$got"
  fi
  if grep -q 'TODO_' "$file"; then
    echo "built-env: the emitted config contains a TODO_ sentinel"
    bad=1
  fi
  return "$bad"
}

cmd_built_env() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh built-env <dev|production> [emitted wrangler.json]"
  need jq
  local env="$1" file="${2:-$repo_root/dist/holdfast_dev/wrangler.json}"
  eval_built_env "$env" "$file" || fail "built-env: the build output is not a '$env' build — do not deploy it"
  echo "built-env: OK ($env)"
}

# ── stamp / health ──────────────────────────────────────────────────────────────────────────────
# <body> <expected sha> → 0 when the body is the Holdfast build stamp for exactly that commit.
eval_meta() {
  local body="$1" want="$2" project commit
  project="$(printf '%s' "$body" | jq -r '.project // ""' 2>/dev/null)" || project=""
  commit="$(printf '%s' "$body" | jq -r '.commit // ""' 2>/dev/null)" || commit=""
  if [ "$project" != "holdfast" ]; then
    echo "stamp: the response is not a Holdfast build stamp (project='$project')"
    return 1
  fi
  if [ "$commit" != "$want" ]; then
    echo "stamp: deployed commit '$commit' != expected '$want'"
    return 1
  fi
  echo "stamp: deployed commit == $want"
}

cmd_stamp() {
  [ "$#" -ge 2 ] || fail "usage: deploy-lib.sh stamp <base-url> <sha> [tries] [sleep-seconds]"
  need curl jq
  local base="${1%/}" want="$2" tries="${3:-6}" pause="${4:-10}" i body
  is_sha "$want" || fail "stamp: expected a 40-character lowercase commit sha, got '$want'"
  i=1
  while [ "$i" -le "$tries" ]; do
    body="$(curl -sS --max-time 15 -H 'cache-control: no-cache' "$base/__meta" 2>/dev/null)" || body=""
    if eval_meta "$body" "$want"; then
      echo "stamp: OK ($base/__meta, try $i of $tries)"
      return 0
    fi
    [ "$i" -lt "$tries" ] && sleep "$pause"
    i=$((i + 1))
  done
  fail "stamp: $base/__meta did not report commit $want after $tries tries"
}

cmd_health() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh health <base-url>"
  need curl jq
  local base="${1%/}" out status body
  out="$(curl -sS --max-time 15 -w '\n%{http_code}' "$base/api/health" 2>/dev/null)" || fail "health: no answer from $base/api/health"
  status="$(printf '%s\n' "$out" | tail -n 1)"
  body="$(printf '%s\n' "$out" | sed '$d')"
  [ "$status" = "200" ] || fail "health: $base/api/health answered $status, expected 200"
  printf '%s' "$body" | jq -e '.ok == true' >/dev/null 2>&1 || fail "health: $base/api/health is 200 but the body is not {\"ok\":true}"
  echo "health: OK ($base/api/health → 200, ok=true)"
}

# ── files-host ───────────────────────────────────────────────────────────────────────────────────
# GET <url> on the files host must be the Worker's bare answer: 404, text/plain, no cookie. The
# check prints what it saw and ends in exactly one of four outcomes, each with its own exit code:
#
#   0   PASS                 404, text/plain, no set-cookie, no edge challenge.
#   10  WORKER-MISCONFIGURED an answer arrived and nothing marks it as an edge challenge, but it is
#                            not the bare 404 (a 200, an HTML page, a cookie, a redirect, a 403 …).
#                            DANGEROUS: the files host may be serving the app shell or another
#                            Worker's routes. Fix the routes / the Worker; do not ship on top of it.
#                            This is also the verdict whenever the evidence is ambiguous.
#   11  EDGE-CHALLENGE       the response carries `cf-mitigated: challenge` — Cloudflare's marker on
#                            every Challenge Page (developers.cloudflare.com/cloudflare-challenges/
#                            challenge-types/challenge-pages/detect-response/). Cloudflare answered
#                            BEFORE the Worker ran, so the Worker was NOT observed: this is not a
#                            pass and not evidence about the Worker either way. It is zone
#                            configuration and is resolved in the Cloudflare dashboard, not in code:
#                            Security → Settings → Bot traffic → Bot Fight Mode on the files zone
#                            (it challenges datacenter IPs such as CI runners, and cannot be skipped
#                            by a WAF rule or scoped to a path). Then re-run the check.
#   12  UNREACHABLE          no complete HTTP answer (DNS, TLS, connect, timeout) after every try.
#
# Deliberately absent: any bypass, any user-agent or header that would make the probe look like a
# browser, and any retry of a request that WAS answered. Only "no answer at all" is tried again.
FILES_RC_MISCONFIGURED=10
FILES_RC_EDGE_CHALLENGE=11
FILES_RC_UNREACHABLE=12

# The last header block of a curl -D dump, without carriage returns.
last_header_block() { tr -d '\r' | awk '/^HTTP\// { block = "" } { block = block $0 "\n" } END { printf "%s", block }'; }

header_value() { # <headers> <lowercase name> → the first value
  printf '%s\n' "$1" | awk -v want="$2:" 'tolower($1) == want { sub(/^[^:]*:[ \t]*/, ""); print; exit }'
}

# Printable ASCII only, and nothing that could be a credential: query strings and every run of 16
# or more token characters go. Over-redaction is the intended direction.
redact_tokens() {
  LC_ALL=C tr -c '\40-\176' ' ' | LC_ALL=C sed -E 's#\?[^[:space:]"'"'"'<>]*#?<query>#g; s#[A-Za-z0-9_+/=%~-]{16,}#<redacted>#g'
}

show_value() { # one header value, made safe to print
  local v
  v="$(printf '%s' "$1" | redact_tokens | cut -c1-80)"
  if [ -n "$v" ]; then printf '%s' "$v"; else printf '(absent)'; fi
}

# <response headers> → 0 PASS, 10 WORKER-MISCONFIGURED, 11 EDGE-CHALLENGE. Prints the reasons.
eval_files_head() {
  local headers status ctype mitigated bad=0
  headers="$(printf '%s' "$1" | last_header_block)"
  status="$(printf '%s\n' "$headers" | awk 'NR == 1 && /^HTTP\// { print $2 }')"
  ctype="$(header_value "$headers" content-type | tr '[:upper:]' '[:lower:]' | sed -E 's/[;[:space:]].*$//')"
  mitigated="$(header_value "$headers" cf-mitigated | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if ! [[ "$status" =~ ^[0-9]{3}$ ]]; then
    echo "files-host: no HTTP status line in the response"
    return "$FILES_RC_MISCONFIGURED"
  fi
  # The edge marker is read first: a challenge page also sets cookies and is text/html.
  if [ "$mitigated" = "challenge" ]; then
    echo "files-host: cf-mitigated: challenge — Cloudflare's edge answered (status $status), the Worker did not run"
    return "$FILES_RC_EDGE_CHALLENGE"
  fi
  if [ "$status" != "404" ]; then
    echo "files-host: status '$status', expected 404"
    bad=1
  fi
  if [ "$ctype" != "text/plain" ]; then
    echo "files-host: content-type '$ctype', expected text/plain (the SPA shell must never be served here)"
    bad=1
  fi
  if printf '%s\n' "$headers" | grep -qi '^set-cookie:'; then
    echo "files-host: the response sets a cookie"
    bad=1
  fi
  if [ "$bad" = 0 ]; then
    echo "files-host: 404, text/plain, no set-cookie, no edge challenge"
    return 0
  fi
  return "$FILES_RC_MISCONFIGURED"
}

# What was seen, for the person reading a red run. Values are cut and redacted; cf-ray and cookie
# values are never printed.
describe_files_response() { # <headers file> <body file>
  local headers status ctype size cookies ray sandbox robots
  headers="$(last_header_block <"$1")"
  status="$(printf '%s\n' "$headers" | awk 'NR == 1 && /^HTTP\// { print $2 }')"
  ctype="$(header_value "$headers" content-type)"
  if [ -n "$(header_value "$headers" cf-ray)" ]; then ray="present"; else ray="absent"; fi
  cookies="$(printf '%s\n' "$headers" | awk 'tolower($1) == "set-cookie:" { split($2, kv, "="); printf "%s%s", sep, kv[1]; sep = "," }' | redact_tokens | cut -c1-80)"
  echo "files-host: saw status=$(show_value "$status") content-type=$(show_value "$ctype") server=$(show_value "$(header_value "$headers" server)")"
  echo "files-host: saw cf-mitigated=$(show_value "$(header_value "$headers" cf-mitigated)") cf-ray=$ray set-cookie=${cookies:-(none)} location=$(show_value "$(header_value "$headers" location)")"
  # Context only, never the verdict: the Worker stamps these on every files-host answer.
  if header_value "$headers" content-security-policy | grep -qi 'sandbox'; then sandbox="present"; else sandbox="absent"; fi
  if [ -n "$(header_value "$headers" x-robots-tag)" ]; then robots="present"; else robots="absent"; fi
  echo "files-host: saw the Worker's own headers: content-security-policy sandbox=$sandbox, x-robots-tag=$robots"
  size="$(wc -c <"$2" | tr -d ' ')"
  case "$(printf '%s' "$ctype" | tr '[:upper:]' '[:lower:]')" in
    text/* | *json* | *xml*)
      echo "files-host: saw body ($size bytes; first 200, redacted): $(head -c 2048 "$2" | redact_tokens | tr -s ' ' | cut -c1-200)"
      ;;
    *) echo "files-host: saw body ($size bytes) — not a text content-type, not shown" ;;
  esac
}

files_verdict() { # <exit code> <class> <message> — the one line a person needs, then exit
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "$1" != 0 ]; then printf '::error::files-host: %s — %s\n' "$2" "$3"; fi
  if [ "$1" = 0 ]; then printf 'files-host: %s — %s\n' "$2" "$3"; else printf 'FAIL: files-host: %s — %s\n' "$2" "$3" >&2; fi
  exit "$1"
}

cmd_files_host() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh files-host <url> [tries] [sleep-seconds]"
  need curl awk sed
  local url="$1" tries="${2:-3}" pause="${3:-5}" i=1 rc=0 tmp answered=0 curl_error="" verdict=0
  [[ "$tries" =~ ^[1-9][0-9]*$ ]] && [[ "$pause" =~ ^[0-9]+$ ]] || fail "files-host: tries and sleep must be numbers"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-files-host.XXXXXX")"
  # Tried again ONLY when nothing answered. A response of any kind is final.
  while [ "$i" -le "$tries" ]; do
    rc=0
    : >"$tmp/headers" && : >"$tmp/body"
    curl -sS --max-time 15 -D "$tmp/headers" -o "$tmp/body" "$url" 2>"$tmp/err" || rc=$?
    if [ "$rc" = 0 ] && grep -q '^HTTP/' "$tmp/headers"; then
      answered=1
      break
    fi
    curl_error="curl exit $rc: $(redact_tokens <"$tmp/err" | tr -s ' ' | cut -c1-160)"
    echo "files-host: try $i of $tries got no complete answer ($curl_error)"
    [ "$i" -lt "$tries" ] && sleep "$pause"
    i=$((i + 1))
  done
  if [ "$answered" != 1 ]; then
    rm -rf "$tmp"
    files_verdict "$FILES_RC_UNREACHABLE" "UNREACHABLE" "no complete HTTP answer from $url after $tries tries ($curl_error). Nothing was observed: check DNS, the custom domain and the route, then run again."
  fi
  describe_files_response "$tmp/headers" "$tmp/body"
  eval_files_head "$(cat "$tmp/headers")" || verdict=$?
  rm -rf "$tmp"
  case "$verdict" in
    0) files_verdict 0 "PASS" "$url is the bare files host" ;;
    "$FILES_RC_EDGE_CHALLENGE")
      files_verdict "$FILES_RC_EDGE_CHALLENGE" "EDGE-CHALLENGE" "Cloudflare challenged this probe before the Worker ran, so $url was NOT checked (this is not a pass, and says nothing about the Worker). Not fixable in code: in the Cloudflare dashboard, on the files zone, Security → Settings → Bot traffic → turn Bot Fight Mode off (it challenges datacenter IPs such as this runner), then re-run. From a residential network the same URL shows what the Worker really serves."
      ;;
    *)
      files_verdict "$FILES_RC_MISCONFIGURED" "WORKER-MISCONFIGURED" "$url answered, without Cloudflare's challenge marker (cf-mitigated), something other than the bare 404 text/plain. Treat it as the Worker or its routes serving the wrong thing on the files host until shown otherwise — read the lines above (if the body is plainly a Cloudflare block page and the Worker's own headers are absent, an edge rule intercepted it)."
      ;;
  esac
}

# ── branch-head ──────────────────────────────────────────────────────────────────────────────────
# A deploy job that waited in the queue, or a re-run of an old run, must not put old code back.
cmd_branch_head() {
  [ "$#" -ge 2 ] || fail "usage: deploy-lib.sh branch-head <branch> <sha>"
  need git
  local branch="$1" sha="$2" head
  [[ "$branch" =~ ^[A-Za-z0-9._-]+$ ]] || fail "branch-head: bad branch name"
  is_sha "$sha" || fail "branch-head: expected a 40-character commit sha"
  head="$(git -C "$repo_root" ls-remote origin "refs/heads/$branch" | awk '{ print $1 }')"
  [ -n "$head" ] || fail "branch-head: could not read origin/$branch"
  [ "$head" = "$sha" ] || fail "branch-head: this run is for $sha but origin/$branch is now $head — a newer push supersedes it; not deploying old code"
  echo "branch-head: OK ($sha is the head of origin/$branch)"
}

# ── containers-plan ──────────────────────────────────────────────────────────────────────────────
# `wrangler deploy` with a Dockerfile path always builds and pushes the scanner image. When nothing
# under containers/ (or the container settings in wrangler.jsonc) changed since the commit that is
# LIVE, the deploy uses `--containers-rollout none` and leaves the running container alone. The
# base is the deployed commit (from /__meta), not the previous push: a push whose deploy failed
# must not hide its container change from the next one. Any doubt → build.
plan_from_shas() { # <deployed sha or ""> <head sha> → prints "build <reason>" or "none <reason>"
  local deployed="$1" head="$2" changed
  if [ "${SCANNER_ALWAYS_BUILD:-false}" = "true" ]; then echo "build SCANNER_ALWAYS_BUILD is set" && return 0; fi
  if ! is_sha "$deployed"; then echo "build the deployed commit is unknown" && return 0; fi
  if ! git -C "$repo_root" cat-file -e "$deployed^{commit}" 2>/dev/null; then
    echo "build the deployed commit $deployed is not in this checkout" && return 0
  fi
  if ! git -C "$repo_root" merge-base --is-ancestor "$deployed" "$head" 2>/dev/null; then
    echo "build the deployed commit $deployed is not an ancestor of $head" && return 0
  fi
  changed="$(git -C "$repo_root" diff --name-only "$deployed" "$head" -- containers wrangler.jsonc | wc -l | tr -d ' ')"
  if [ "$changed" != "0" ]; then echo "build $changed file(s) under containers/ or wrangler.jsonc changed since $deployed" && return 0; fi
  echo "none nothing under containers/ or wrangler.jsonc changed since the deployed commit $deployed"
}

cmd_containers_plan() {
  [ "$#" -ge 2 ] || fail "usage: deploy-lib.sh containers-plan <base-url> <head-sha>"
  need curl jq git
  local base="${1%/}" head="$2" body deployed plan rollout
  is_sha "$head" || fail "containers-plan: expected a 40-character commit sha"
  body="$(curl -sS --max-time 15 "$base/__meta" 2>/dev/null)" || body=""
  deployed="$(printf '%s' "$body" | jq -r 'select(.project == "holdfast") | .commit // ""' 2>/dev/null)" || deployed=""
  plan="$(plan_from_shas "$deployed" "$head")"
  rollout="${plan%% *}"
  echo "containers-plan: $rollout (${plan#* })"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "rollout=$rollout" >>"$GITHUB_OUTPUT"
    # The live commit, for the migration rule ("" when it could not be read).
    if is_sha "$deployed"; then echo "deployed=$deployed" >>"$GITHUB_OUTPUT"; else echo "deployed=" >>"$GITHUB_OUTPUT"; fi
  fi
}

# ── live-migration-rule ──────────────────────────────────────────────────────────────────────────
# The migration rule against the commit that is LIVE (CI checked it against the previous push;
# after a failed deploy that is not what is running). The live commit must be readable: when it is
# not — /__meta did not answer with a commit, or the commit is not in this checkout — the rule
# cannot be checked, and a rule that was not checked is a failure, never a pass with a notice.
# Every Worker this deploys already exists and carries a build stamp, so there is no first-run
# exemption.
live_base() { # <deployed sha or ""> → 0 and prints the sha when it can be compared against
  local deployed="$1"
  if ! is_sha "$deployed"; then
    echo "the live commit could not be read from the build stamp (/__meta)"
    return 1
  fi
  if ! git -C "$repo_root" cat-file -e "$deployed^{commit}" 2>/dev/null; then
    echo "the live commit $deployed is not in this checkout"
    return 1
  fi
  echo "$deployed"
}

cmd_live_migration_rule() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh live-migration-rule <deployed-sha>"
  need git node
  local base
  base="$(live_base "$1")" ||
    fail "live-migration-rule: $base — the migration rule cannot be checked against what is running, so this deploy stops before it migrates. Fix the stamp (or redeploy the previous commit by hand) and run again."
  (cd "$repo_root" && node scripts/check-migrations.mjs --base "$base" --head HEAD)
}

# ── worker-ready / secrets ───────────────────────────────────────────────────────────────────────
eval_secret_names() { # <file with `wrangler secret list --format json` output>
  local file="$1" have missing="" name
  have="$(json_tail <"$file" | jq -r 'if type == "array" then .[].name else empty end' 2>/dev/null | sort -u)" || have=""
  if [ -z "$have" ]; then
    echo "secrets: the secret list is empty or could not be read"
    return 1
  fi
  for name in $REQUIRED_SECRETS; do
    printf '%s\n' "$have" | grep -qx "$name" || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    echo "secrets: missing:$missing"
    return 1
  fi
  echo "secrets: all nine names present ($(printf '%s\n' "$have" | wc -l | tr -d ' ') listed)"
}

eval_deployments() { # <file with `wrangler deployments list --json` output>
  local file="$1" count
  count="$(json_tail <"$file" | jq -r 'if type == "array" then length else ((.deployments // .items // []) | length) end' 2>/dev/null)" || count=""
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ]; then
    echo "worker-ready: no deployment could be read for this Worker"
    return 1
  fi
  echo "worker-ready: $count deployment(s) on record"
}

cmd_secrets() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh secrets <worker-name>"
  need jq npx
  local worker="$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/holdfast-secrets.XXXXXX")"
  # Names only: `wrangler secret list` never returns values.
  (cd "$repo_root" && npx wrangler secret list --name "$worker" --format json) >"$tmp" 2>/dev/null ||
    { rm -f "$tmp" && fail "secrets: 'wrangler secret list --name $worker' failed (does the Worker exist? is wrangler authenticated?)"; }
  if eval_secret_names "$tmp"; then rm -f "$tmp"; else rm -f "$tmp" && fail "secrets: Worker '$worker' does not have its nine secrets"; fi
  echo "secrets: OK ($worker)"
}

# The first deploy of an environment is done by hand (the CI token cannot attach a custom domain),
# after its secrets are set. CI must never be the one that creates a Worker.
cmd_worker_ready() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh worker-ready <worker-name>"
  need jq npx
  local worker="$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/holdfast-deployments.XXXXXX")"
  (cd "$repo_root" && npx wrangler deployments list --name "$worker" --json) >"$tmp" 2>/dev/null ||
    { rm -f "$tmp" && fail "worker-ready: Worker '$worker' has no deployments (or cannot be read). Its first deploy is done locally, after its secrets are set — CI does not create it."; }
  if eval_deployments "$tmp"; then rm -f "$tmp"; else rm -f "$tmp" && fail "worker-ready: Worker '$worker' has never been deployed; CI does not do a first deploy"; fi
  cmd_secrets "$worker"
  echo "worker-ready: OK ($worker)"
}

# ── migrate ──────────────────────────────────────────────────────────────────────────────────────
# drizzle-kit prints the same success line whether it applied ten files or none, so this counts
# the rows of its bookkeeping table against the journal instead of reading its prose.
url_host() {
  local rest="${1#*://}"
  rest="${rest%%[/?]*}"
  rest="${rest##*@}"
  if [[ "$rest" == \[* ]]; then echo "${rest%%]*}]"; else echo "${rest%%:*}"; fi
}

is_local_host() {
  case "$1" in localhost | 127.0.0.1 | ::1 | '[::1]') return 0 ;; *) return 1 ;; esac
}

# ── utc-zone ─────────────────────────────────────────────────────────────────────────────────────
# The auth tables (generated; not ours to edit) keep time in zone-less `timestamp` columns filled
# by `DEFAULT now()`. Postgres converts now() to the SESSION's zone when it stores it there, so on
# a database whose zone is not UTC every such default is wrong by the zone's offset (-5 h / -6 h
# under America/Chicago). The Worker's sessions come through Hyperdrive, which keeps no session
# state: their zone is whatever the server, the database or the role says. This check reads that,
# and requires a ZERO offset from UTC in January and in July of the current year — a name is not
# compared (UTC, Etc/UTC, GMT all pass), and a zone that is UTC only in winter (Europe/London)
# fails. It looks at:
#   - the zone a plain new session gets (with this shell's PGTZ / PGOPTIONS removed), and where the
#     setting comes from — a zone set by the connection itself hides the database's own, so it fails;
#   - every `ALTER DATABASE … SET timezone` / `ALTER ROLE … [IN DATABASE …] SET timezone` that
#     applies to this database, for ANY role (the Worker's role may not be the one that migrates).
# One row per zone found: kind|zone|january offset (s)|july offset (s)|database.
UTC_ZONE_SQL="
with instants(jan, jul) as (
  select date_trunc('year', now() at time zone 'UTC') + interval '14 days 12 hours',
         date_trunc('year', now() at time zone 'UTC') + interval '6 months 14 days 12 hours'
), zones(kind, zone) as (
  select 'session:' || source, setting from pg_settings where name = 'TimeZone'
  union all
  select case when s.setrole = 0 and s.setdatabase = 0 then 'setting:all-roles'
              when s.setrole = 0 then 'setting:database'
              when s.setdatabase = 0 then 'setting:role'
              else 'setting:role-in-database' end,
         substr(c.cfg, strpos(c.cfg, '=') + 1)
  from pg_db_role_setting s cross join lateral unnest(s.setconfig) as c(cfg)
  where s.setdatabase in (0, (select oid from pg_database where datname = current_database()))
    and lower(split_part(c.cfg, '=', 1)) = 'timezone'
)
select z.kind, z.zone,
       extract(epoch from (i.jan at time zone 'UTC') - (i.jan at time zone z.zone))::int,
       extract(epoch from (i.jul at time zone 'UTC') - (i.jul at time zone z.zone))::int,
       current_database()
from zones z cross join instants i
order by 1, 2"

# <file with the rows of UTC_ZONE_SQL> → 0 only when a session row was read and every zone is UTC.
eval_utc_zone() {
  [ -s "$1" ] || { echo "utc-zone: the query returned nothing — the time zone was not observed" && return 1; }
  awk -F '|' '
    function hhmm(s,   sign, a) { sign = (s < 0) ? "-" : "+"; a = (s < 0) ? -s : s; return sprintf("UTC%s%02d:%02d", sign, int(a / 3600), int((a % 3600) / 60)) }
    function fix(kind, db) {
      if (kind == "session:database" || kind == "setting:database") return "ALTER DATABASE \"" db "\" SET timezone TO \x27UTC\x27;"
      if (kind == "session:user" || kind == "setting:role") return "a role has its own zone: ALTER ROLE <that role> SET timezone TO \x27UTC\x27; (or RESET timezone)"
      if (kind == "session:database user" || kind == "setting:role-in-database") return "a role has its own zone in this database: ALTER ROLE <that role> IN DATABASE \"" db "\" RESET timezone;"
      if (kind == "setting:all-roles") return "ALTER ROLE ALL RESET timezone;"
      return "the SERVER default is not UTC: set timezone = \x27UTC\x27 in the server configuration (local docker: the image default is UTC — check TZ/PGTZ and `-c timezone` on the container), or pin the database: ALTER DATABASE \"" db "\" SET timezone TO \x27UTC\x27;"
    }
    BEGIN { bad = 0; sessions = 0 }
    NF != 5 || $1 !~ /^(session|setting):[a-z -]+$/ || $3 !~ /^-?[0-9]+$/ || $4 !~ /^-?[0-9]+$/ {
      print "utc-zone: unreadable row in the query output (" NF " field(s)) — the time zone was not observed"; bad = 1; next
    }
    {
      kind = $1; zone = $2; jan = $3 + 0; jul = $4 + 0; db = $5
      what = kind; sub(/^session:/, "a new session (source: ", what); if (kind ~ /^session:/) what = what ")"
      sub(/^setting:/, "a stored setting (", what); if (kind ~ /^setting:/) what = what ")"
      printf "utc-zone: database \"%s\", %s: zone \x27%s\x27, January %s, July %s\n", db, what, zone, hhmm(jan), hhmm(jul)
      if (kind ~ /^session:/) {
        sessions++
        src = substr(kind, 9)
        if (src !~ /^(default|environment variable|configuration file|command line|global|database|user|database user)$/) {
          print "utc-zone: NOT OBSERVED — this connection set its own time zone (source: " src "), which hides the database\x27s. Remove `options=-c timezone…` from the connection string and run again."
          bad = 1
        }
      }
      if (jan != 0 || jul != 0) {
        print "utc-zone: NOT UTC — \x27" zone "\x27 is " hhmm(jan) " in January and " hhmm(jul) " in July. Every DEFAULT now() written to a zone-less timestamp column would be off by that much. Fix: " fix(kind, db)
        bad = 1
      }
    }
    END {
      if (sessions != 1) { print "utc-zone: expected exactly one session row, read " sessions " — the time zone was not observed"; bad = 1 }
      exit bad
    }' "$1"
}

# psql error text with the connection's parts taken out (psql names the host and the user).
scrub_connection() { # <text> <url>
  local text="$1" url="$2" host userinfo user="" password=""
  host="$(url_host "$url")"
  userinfo="${url#*://}"
  if [[ "$userinfo" == *@* ]]; then
    userinfo="${userinfo%%@*}"
    user="${userinfo%%:*}"
    if [[ "$userinfo" == *:* ]]; then password="${userinfo#*:}"; fi
  fi
  if [ -n "$password" ]; then text="${text//"$password"/<password>}"; fi
  if [ -n "$host" ]; then text="${text//"$host"/<host>}"; fi
  if [ -n "$user" ]; then text="${text//"$user"/<user>}"; fi
  # psql also prints the address the host resolved to.
  printf '%s\n' "$text" | redact | sed -E 's/\(([0-9]{1,3}\.){3}[0-9]{1,3}\)|\([0-9A-Fa-f:]*:[0-9A-Fa-f:]+\)/(<address>)/g'
}

# Reads DATABASE_URL_DIRECT from the environment; never prints it or any part of it.
cmd_utc_zone() {
  need psql awk
  local url="${DATABASE_URL_DIRECT:-}" tmp rc=0 verdict=0
  [ -n "$url" ] || fail "utc-zone: DATABASE_URL_DIRECT is empty — no database was checked"
  [[ "$url" =~ ^postgres(ql)?:// ]] || fail "utc-zone: DATABASE_URL_DIRECT is not a postgres:// URL — no database was checked"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-utc-zone.XXXXXX")"
  # PGTZ / PGOPTIONS in this shell would set the session's zone and answer for the database.
  env -u PGTZ -u PGOPTIONS PGCONNECT_TIMEOUT=15 psql "$url" -X -Atq -F '|' -v ON_ERROR_STOP=1 -c "$UTC_ZONE_SQL" >"$tmp/rows" 2>"$tmp/err" || rc=$?
  if [ "$rc" != 0 ]; then
    scrub_connection "$(head -c 600 "$tmp/err")" "$url" | sed 's/^/  psql: /' >&2
    rm -rf "$tmp"
    fail "utc-zone: the time zone query could not run (psql exit $rc) — the database's zone was NOT checked, so this stops here. Check that the database is reachable and the URL is right."
  fi
  eval_utc_zone "$tmp/rows" || verdict=1
  rm -rf "$tmp"
  [ "$verdict" = 0 ] || fail "utc-zone: the target database does not keep UTC time (or its zone could not be read) — see the lines above. Nothing was migrated."
  echo "utc-zone: OK (zero UTC offset in January and July, for the session default and every stored setting)"
}

migration_rows() { # prints the number of applied migrations, or "none" when the table does not exist
  local exists
  exists="$(psql "$DATABASE_URL_DIRECT" -X -Atq -v ON_ERROR_STOP=1 -c "select to_regclass('$MIGRATIONS_TABLE') is not null" 2>&1)" ||
    { printf '%s\n' "$exists" | redact >&2 && return 1; }
  if [ "$exists" != "t" ]; then echo "none" && return 0; fi
  psql "$DATABASE_URL_DIRECT" -X -Atq -v ON_ERROR_STOP=1 -c "select count(*) from $MIGRATIONS_TABLE" 2> >(redact >&2)
}

cmd_migrate() {
  [ "$#" -ge 2 ] || fail "usage: deploy-lib.sh migrate <apply|none-pending> <local|remote>"
  need jq psql npm
  local mode="$1" where="$2" url="${DATABASE_URL_DIRECT:-}" host userinfo
  case "$mode" in apply | none-pending) ;; *) fail "migrate: mode must be 'apply' or 'none-pending'" ;; esac
  [ -n "$url" ] || fail "migrate: DATABASE_URL_DIRECT is empty (is the secret set and passed to this step?)"
  [[ "$url" =~ ^postgres(ql)?:// ]] || fail "migrate: DATABASE_URL_DIRECT is not a postgres:// URL"
  host="$(url_host "$url")"
  [ -n "$host" ] || fail "migrate: DATABASE_URL_DIRECT has no host"
  case "$where" in
    local) is_local_host "$host" || fail "migrate: 'local' was requested but DATABASE_URL_DIRECT does not point at localhost" ;;
    remote)
      ! is_local_host "$host" || fail "migrate: 'remote' was requested but DATABASE_URL_DIRECT points at localhost"
      # GitHub masks the whole secret; its parts (host, password) are masked here, in case a tool
      # prints one on its own.
      if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
        echo "::add-mask::$host"
        userinfo="${url#*://}"
        if [[ "$userinfo" == *@* ]]; then
          userinfo="${userinfo%%@*}"
          if [[ "$userinfo" == *:* ]] && [ -n "${userinfo#*:}" ]; then echo "::add-mask::${userinfo#*:}"; fi
        fi
      fi
      ;;
    *) fail "migrate: target must be 'local' or 'remote'" ;;
  esac

  # Before anything is read or written: a database that is not on UTC must not be migrated.
  cmd_utc_zone

  cd "$repo_root"
  # Never read green on a tree that has no migrations: absence is a failure, not "0 to apply".
  [ -f drizzle.config.ts ] || fail "migrate: drizzle.config.ts is missing — this tree has no migrations to apply"
  [ -f "$MIGRATIONS_JOURNAL" ] || fail "migrate: $MIGRATIONS_JOURNAL is missing"
  local want before after out rc
  want="$(jq -r '.entries | length' "$MIGRATIONS_JOURNAL")"
  [[ "$want" =~ ^[0-9]+$ ]] && [ "$want" -gt 0 ] || fail "migrate: the journal lists no migrations"

  before="$(migration_rows)" || fail "migrate: could not read the migrations table"
  [ "$before" = "none" ] && before=0
  if [ "$mode" = "none-pending" ] && [ "$before" != "$want" ]; then
    fail "migrate: $before migration(s) applied, the journal has $want — migrations are pending (target: $where)"
  fi

  set +e
  out="$(npm run --silent db:migrate 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out" | redact | sed 's/^/  drizzle-kit: /'
  [ "$rc" = 0 ] || fail "migrate: 'npm run db:migrate' exited $rc"

  after="$(migration_rows)" || fail "migrate: could not read the migrations table after migrating"
  echo "migrate: journal=$want applied_before=$before applied_after=$after (target: $where)"
  [ "$after" = "$want" ] || fail "migrate: after migrating, $after migration(s) are recorded but the journal has $want"
  if [ "$mode" = "none-pending" ]; then
    echo "migrate: OK — re-running applied 0 migrations"
  else
    echo "migrate: OK — $((after - before)) migration(s) newly applied"
  fi
}

# ── utc-zone-self-test ───────────────────────────────────────────────────────────────────────────
# The guard against a real LOCAL Postgres (the docker-compose.test.yml server / the CI service):
# scratch databases with a zone set by ALTER DATABASE, dropped afterwards. Never a skip: no
# reachable local Postgres is a failure. It only issues ALTER DATABASE / ALTER ROLE … IN DATABASE
# on its own scratch objects — nothing server-wide, nothing on another database.
cmd_utc_zone_self_test() {
  need psql awk
  local host="${HOLDFAST_DB_HOST:-localhost}" port="${HOLDFAST_DB_PORT:-5432}" failures=0 base n
  # Not `local`: the EXIT trap below runs after this function's scope is gone.
  utc_st_prefix="holdfast_ciguards" utc_st_admin="" utc_st_tmp=""
  local prefix="$utc_st_prefix" admin tmp
  is_local_host "$host" || fail "utc-zone-self-test: the host is '$host' — this only ever runs against a local Postgres"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "utc-zone-self-test: HOLDFAST_DB_PORT must be a number"
  # The local test server's well-known credentials (docker-compose.test.yml, ci.yml) — not a secret.
  base="postgres://postgres:postgres@$host:$port"
  admin="$base/postgres"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-utc-selftest.XXXXXX")"
  utc_st_admin="$admin" utc_st_tmp="$tmp"
  PGCONNECT_TIMEOUT=10 psql "$admin" -X -Atqc 'select 1' >/dev/null 2>&1 ||
    { rm -rf "$tmp" && fail "utc-zone-self-test: no local Postgres on $host:$port — nothing was tested"; }

  cleanup_utc_selftest() {
    local d
    for d in utc chicago london role; do
      psql "$utc_st_admin" -X -q -c "DROP DATABASE IF EXISTS \"${utc_st_prefix}_$d\" WITH (FORCE)" >/dev/null 2>&1 || true
    done
    psql "$utc_st_admin" -X -q -c "DROP ROLE IF EXISTS \"${utc_st_prefix}_role\"" >/dev/null 2>&1 || true
    rm -rf "$utc_st_tmp"
  }
  trap cleanup_utc_selftest EXIT
  cleanup_utc_selftest
  mkdir -p "$tmp"
  for n in utc chicago london role; do
    psql "$admin" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${prefix}_$n\"" || fail "utc-zone-self-test: could not create a scratch database"
  done
  PGOPTIONS="-c client_min_messages=warning" psql "$admin" -X -q -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE \"${prefix}_utc\" SET timezone TO 'UTC'" \
    -c "ALTER DATABASE \"${prefix}_chicago\" SET timezone TO 'America/Chicago'" \
    -c "ALTER DATABASE \"${prefix}_london\" SET timezone TO 'Europe/London'" \
    -c "ALTER DATABASE \"${prefix}_role\" SET timezone TO 'UTC'" \
    -c "CREATE ROLE \"${prefix}_role\" NOLOGIN" \
    -c "ALTER ROLE \"${prefix}_role\" IN DATABASE \"${prefix}_role\" SET timezone TO 'Asia/Tokyo'" ||
    fail "utc-zone-self-test: could not set up the scratch databases"

  check() { # <pass|fail> <text the output must contain> <label> <command...>
    local want="$1" needle="$2" label="$3" got
    shift 3
    if ("$@") >"$tmp/out" 2>&1; then got="pass"; else got="fail"; fi
    # No output may ever carry the password part of a URL that was used.
    if [ "$got" = "$want" ] && grep -qF -- "$needle" "$tmp/out" && ! grep -qE 'postgres(ql)?://[^[:space:]]*@|:postgres@|wrong-pw-ciguards' "$tmp/out"; then
      echo "  ok    $label → $got ($needle)"
    else
      echo "  WRONG $label → $got, expected $want with '$needle' and no connection string in the output"
      sed -E 's#postgres(ql)?://[^[:space:]]+#<database-url>#g; s/^/        /' "$tmp/out"
      failures=$((failures + 1))
    fi
  }
  guard() { DATABASE_URL_DIRECT="$1" cmd_utc_zone; }
  migrate_refused() { # the migrate path stops before drizzle-kit: no bookkeeping table afterwards
    local rc=0
    (DATABASE_URL_DIRECT="$1" cmd_migrate apply local) >"$tmp/migrate.out" 2>&1 || rc=$?
    [ "$rc" != 0 ] || { echo "migrate did not fail" && return 1; }
    grep -q 'utc-zone: NOT UTC' "$tmp/migrate.out" || { echo "migrate failed, but not on the time zone" && return 1; }
    ! grep -q 'drizzle-kit' "$tmp/migrate.out" || { echo "drizzle-kit ran" && return 1; }
    [ "$(psql "$1" -X -Atqc "select to_regclass('$MIGRATIONS_TABLE') is null")" = "t" ] || { echo "migrations WERE applied" && return 1; }
    echo "migrate refused; no migration table was created"
  }

  echo "utc-zone against the local Postgres on $host:$port:"
  check pass "utc-zone: OK" "a database on UTC" guard "$base/${prefix}_utc"
  check fail "America/Chicago" "a database on America/Chicago" guard "$base/${prefix}_chicago"
  check fail "ALTER DATABASE \"${prefix}_chicago\" SET timezone TO 'UTC'" "… and the message gives the fix" guard "$base/${prefix}_chicago"
  check fail "Europe/London" "a database on Europe/London (UTC in winter only)" guard "$base/${prefix}_london"
  check fail "UTC+01:00" "… and the July offset is what fails it" guard "$base/${prefix}_london"
  PGTZ=Etc/UTC check fail "America/Chicago" "Chicago database, PGTZ=Etc/UTC in the shell (must not mask it)" guard "$base/${prefix}_chicago"
  PGOPTIONS="-c timezone=UTC" check fail "America/Chicago" "Chicago database, PGOPTIONS sets UTC (must not mask it)" guard "$base/${prefix}_chicago"
  check fail "this connection set its own time zone" "a URL that sets the zone itself (options=-c timezone=UTC)" guard "$base/${prefix}_chicago?options=-c%20timezone%3DUTC"
  check fail "Asia/Tokyo" "UTC database, another role pinned to Asia/Tokyo in it" guard "$base/${prefix}_role"
  PGTZ=America/Chicago check pass "utc-zone: OK" "UTC database, PGTZ=America/Chicago in the shell (the shell is not the database)" guard "$base/${prefix}_utc"
  echo "fails closed when the query cannot run:"
  check fail "NOT checked" "nothing listening (port 1)" guard "postgres://postgres:postgres@127.0.0.1:1/${prefix}_utc"
  check fail "NOT checked" "wrong password" guard "postgres://postgres:wrong-pw-ciguards@$host:$port/${prefix}_utc"
  check fail "NOT checked" "a database that does not exist" guard "$base/${prefix}_absent"
  check fail "not a postgres:// URL" "a URL that is not a database URL" guard "http://localhost/x"
  check fail "is empty" "an empty URL" guard ""
  echo "the migrate path:"
  check pass "migrate refused; no migration table was created" "migrate on the Chicago database stops before any migration" migrate_refused "$base/${prefix}_chicago"

  [ "$failures" = 0 ] || fail "utc-zone-self-test: $failures case(s) gave the wrong verdict"
  # Proof that nothing is left behind, not an assumption that the trap will manage.
  cleanup_utc_selftest
  n="$(psql "$admin" -X -Atqc "select (select count(*) from pg_database where datname in ('${prefix}_utc', '${prefix}_chicago', '${prefix}_london', '${prefix}_role')) + (select count(*) from pg_roles where rolname = '${prefix}_role')")" || n="unknown"
  [ "$n" = "0" ] || fail "utc-zone-self-test: $n scratch object(s) were left on the server"
  echo "utc-zone-self-test: OK (scratch databases and role dropped)"
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────────
cmd_self_test() {
  need jq git awk
  local tmp failures=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-lib-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  expect() { # <pass|fail> <label> <command...>
    local want="$1" label="$2" got
    shift 2
    if "$@" >"$tmp/out" 2>&1; then got="pass"; else got="fail"; fi
    if [ "$got" = "$want" ]; then
      echo "  ok    $label → $got"
    else
      echo "  WRONG $label → $got, expected $want"
      sed 's/^/        /' "$tmp/out"
      failures=$((failures + 1))
    fi
  }

  local sha_a="1111111111111111111111111111111111111111" sha_b="2222222222222222222222222222222222222222"

  echo "stamp:"
  expect pass "matching commit" eval_meta "{\"project\":\"holdfast\",\"commit\":\"$sha_a\"}" "$sha_a"
  expect fail "wrong commit" eval_meta "{\"project\":\"holdfast\",\"commit\":\"$sha_b\"}" "$sha_a"
  expect fail "another project's stamp" eval_meta "{\"project\":\"other\",\"commit\":\"$sha_a\"}" "$sha_a"
  expect fail "HTML instead of JSON (SPA shell)" eval_meta "<!doctype html><title>Holdfast</title>" "$sha_a"
  expect fail "empty body (no answer)" eval_meta "" "$sha_a"
  expect fail "commit 'unknown'" eval_meta '{"project":"holdfast","commit":"unknown"}' "$sha_a"

  echo "files-host (the verdict on a set of headers):"
  expect pass "bare 404" eval_files_head "$(printf 'HTTP/2 404 \r\ncontent-type: text/plain; charset=utf-8\r\ncache-control: no-store\r\n')"
  expect fail "403 challenge page" eval_files_head "$(printf 'HTTP/2 403 \r\ncontent-type: text/html; charset=UTF-8\r\ncf-mitigated: challenge\r\nserver: cloudflare\r\n')"
  expect fail "404 text/plain that carries the challenge marker" eval_files_head "$(printf 'HTTP/2 404 \r\ncontent-type: text/plain\r\nCF-Mitigated: challenge\r\n')"
  expect fail "a body with no status line" eval_files_head "content-type: text/plain"
  expect fail "200 SPA shell" eval_files_head "$(printf 'HTTP/2 200 \r\ncontent-type: text/html\r\n')"
  expect fail "404 as HTML" eval_files_head "$(printf 'HTTP/2 404 \r\ncontent-type: text/html\r\n')"
  expect fail "404 with a cookie" eval_files_head "$(printf 'HTTP/2 404 \r\ncontent-type: text/plain\r\nSet-Cookie: a=b\r\n')"
  expect fail "no headers" eval_files_head ""

  echo "built-env:"
  local dev_json="$tmp/dev.json" prod_json="$tmp/prod.json"
  jq -n '{name:"holdfast-dev",
    routes:[{pattern:"holdfast-dev.ponderance.dev",custom_domain:true},{pattern:"dev.holdfastusercontent.com",custom_domain:true}],
    r2_buckets:[{bucket_name:"holdfast-files-dev"}], queues:{producers:[{queue:"holdfast-scan-dev"}]},
    hyperdrive:[{id:"097127f66b124f61abf6e7f5d26925ec"}],
    vars:{SENTRY_ENVIRONMENT:"dev",APP_ORIGIN:"https://holdfast-dev.ponderance.dev",FILES_ORIGIN:"https://dev.holdfastusercontent.com",EMAIL_TRANSPORT:"resend",SCAN_STUB:"0"}}' >"$dev_json"
  jq -n '{name:"holdfast",
    routes:[{pattern:"holdfast.ponderance.dev",custom_domain:true},{pattern:"holdfastusercontent.com",custom_domain:true}],
    r2_buckets:[{bucket_name:"holdfast-files"}], queues:{producers:[{queue:"holdfast-scan"}]},
    hyperdrive:[{id:"e899309ce0d543bb99bd09fa582aac90"}],
    vars:{SENTRY_ENVIRONMENT:"production",APP_ORIGIN:"https://holdfast.ponderance.dev",FILES_ORIGIN:"https://holdfastusercontent.com",EMAIL_TRANSPORT:"resend",SCAN_STUB:"0"}}' >"$prod_json"
  expect pass "dev build as dev" eval_built_env dev "$dev_json"
  expect pass "production build as production" eval_built_env production "$prod_json"
  expect fail "production build offered as dev" eval_built_env dev "$prod_json"
  expect fail "dev build offered as production" eval_built_env production "$dev_json"
  jq '.routes += [{pattern:"holdfast-dev.ponderance.dev",custom_domain:true}]' "$prod_json" >"$tmp/prod-devroute.json"
  expect fail "production build that also claims a dev hostname" eval_built_env production "$tmp/prod-devroute.json"
  jq '.r2_buckets[0].bucket_name = "holdfast-files-dev"' "$prod_json" >"$tmp/prod-devbucket.json"
  expect fail "production build bound to the dev bucket" eval_built_env production "$tmp/prod-devbucket.json"
  jq '.vars.SCAN_STUB = "1"' "$prod_json" >"$tmp/prod-stub.json"
  expect fail "production build with the scan stub on" eval_built_env production "$tmp/prod-stub.json"
  jq '.vars.EMAIL_TRANSPORT = "memory"' "$dev_json" >"$tmp/dev-memory.json"
  expect fail "deployable build with the memory mail transport" eval_built_env dev "$tmp/dev-memory.json"
  expect fail "no build output" eval_built_env dev "$tmp/does-not-exist.json"

  echo "secrets / deployments:"
  local name names=""
  for name in $REQUIRED_SECRETS; do names="$names{\"name\":\"$name\",\"type\":\"secret_text\"},"; done
  printf '[%s]\n' "${names%,}" >"$tmp/secrets-all.json"
  jq 'map(select(.name != "IP_ENC_KEY"))' "$tmp/secrets-all.json" >"$tmp/secrets-eight.json"
  printf ' ⛅️ wrangler 4.148.0\n───────────\n' | cat - "$tmp/secrets-all.json" >"$tmp/secrets-banner.json"
  expect pass "nine names" eval_secret_names "$tmp/secrets-all.json"
  expect pass "nine names after a CLI banner" eval_secret_names "$tmp/secrets-banner.json"
  expect fail "eight names" eval_secret_names "$tmp/secrets-eight.json"
  echo '[]' >"$tmp/empty.json"
  expect fail "empty list" eval_secret_names "$tmp/empty.json"
  echo 'Authentication error [code: 10000]' >"$tmp/error.txt"
  expect fail "an error instead of a list" eval_secret_names "$tmp/error.txt"
  echo '[{"id":"a"},{"id":"b"}]' >"$tmp/deployments.json"
  expect pass "two deployments" eval_deployments "$tmp/deployments.json"
  expect fail "no deployments" eval_deployments "$tmp/empty.json"
  expect fail "an error instead of deployments" eval_deployments "$tmp/error.txt"

  echo "containers-plan:"
  local repo="$tmp/repo" saved_root="$repo_root" c1 c2 c3
  git init -q "$repo"
  git -C "$repo" config user.email "selftest@example.invalid"
  git -C "$repo" config user.name "self-test"
  mkdir -p "$repo/containers/clamav" "$repo/src"
  echo "FROM scratch" >"$repo/containers/clamav/Dockerfile"
  echo "{}" >"$repo/wrangler.jsonc"
  echo "a" >"$repo/src/a.ts"
  git -C "$repo" add -A && git -C "$repo" commit -q -m one
  c1="$(git -C "$repo" rev-parse HEAD)"
  echo "b" >"$repo/src/a.ts"
  git -C "$repo" commit -q -am two
  c2="$(git -C "$repo" rev-parse HEAD)"
  echo "FROM alpine" >"$repo/containers/clamav/Dockerfile"
  git -C "$repo" commit -q -am three
  c3="$(git -C "$repo" rev-parse HEAD)"
  repo_root="$repo"
  plan_is() { [ "$(plan_from_shas "$2" "$3" | cut -d' ' -f1)" = "$1" ]; }
  expect pass "source-only change → none" plan_is none "$c1" "$c2"
  expect pass "Dockerfile change → build" plan_is build "$c2" "$c3"
  expect pass "change two commits back → build" plan_is build "$c1" "$c3"
  expect pass "deployed commit unknown → build" plan_is build "" "$c2"
  expect pass "deployed commit not in the checkout → build" plan_is build "$sha_a" "$c2"
  expect pass "deployed commit ahead of head → build" plan_is build "$c2" "$c1"
  SCANNER_ALWAYS_BUILD=true expect pass "SCANNER_ALWAYS_BUILD → build" plan_is build "$c1" "$c2"

  echo "live-migration-rule (the base it may compare against):"
  expect pass "a live commit that is in the checkout" live_base "$c1"
  expect fail "no live commit (the stamp could not be read)" live_base ""
  expect fail "a stamp that is not a commit sha" live_base "unknown"
  expect fail "a live commit that is not in the checkout" live_base "$sha_a"
  repo_root="$saved_root"

  echo "files-host (the whole check, against a stub server on 127.0.0.1; exit code AND verdict):"
  need node curl
  local stub_pid="" base dead planted="hfsecretTOKEN0123456789abcdefXYZ"
  cat >"$tmp/stub.js" <<'STUB'
const http = require("node:http");
const fs = require("node:fs");
const worker = { "content-security-policy": "sandbox; default-src 'none'", "x-robots-tag": "noindex", "cache-control": "private, no-store" };
const edge = { server: "cloudflare", "cf-ray": "8f00000000000000-IAD" };
const token = process.argv[3];
const routes = {
  "/ok": [404, { "content-type": "text/plain; charset=utf-8", ...worker, ...edge }, "Not found"],
  "/spa": [200, { "content-type": "text/html; charset=utf-8", ...edge }, "<!doctype html><title>Holdfast</title><div id=root></div>"],
  "/html404": [404, { "content-type": "text/html", ...edge }, "<h1>Not found</h1>"],
  "/cookie": [404, { "content-type": "text/plain", "set-cookie": `session=${token}; Path=/`, ...worker, ...edge }, "Not found"],
  "/worker403": [403, { "content-type": "application/json", ...worker, ...edge }, '{"error":"invalid_token"}'],
  "/redirect": [301, { location: `https://holdfast-dev.ponderance.dev/?next=${token}`, ...edge }, ""],
  "/block": [403, { "content-type": "text/html", ...edge }, "<title>Attention Required! | Cloudflare</title>"],
  "/challenge": [403, { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge", "set-cookie": `__cf_bm=${token}; path=/`, ...edge },
    `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=${token}"></script>`],
  "/challenge404": [404, { "content-type": "text/plain", "cf-mitigated": "challenge", ...edge }, "Not found"],
  "/leak": [200, { "content-type": "text/plain", ...edge }, `token=${token} Bearer ${token}\u0000\u0007 https://x.example/dl?sig=${token.slice(0, 12)}`],
  "/binary": [200, { "content-type": "application/octet-stream", ...edge }, `${token}`],
};
const server = http.createServer((req, res) => {
  const r = routes[req.url];
  if (!r) return req.socket.destroy();
  res.writeHead(r[0], r[1]);
  res.end(r[2]);
});
// A port nobody listens on: bound once, then closed.
const spare = http.createServer();
spare.listen(0, "127.0.0.1", () => {
  const dead = spare.address().port;
  spare.close(() => server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], `${server.address().port} ${dead}\n`)));
});
STUB
  node "$tmp/stub.js" "$tmp/ports" "$planted" >/dev/null 2>&1 &
  stub_pid=$!
  # shellcheck disable=SC2064
  trap "kill $stub_pid 2>/dev/null; rm -rf '$tmp'" EXIT
  local waited=0
  while [ ! -s "$tmp/ports" ] && [ "$waited" -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  # No stub = nothing was tested = a failure of the self-test, never a skip.
  [ -s "$tmp/ports" ] || fail "self-test: the files-host stub server did not start"
  base="http://127.0.0.1:$(cut -d' ' -f1 "$tmp/ports")"
  dead="http://127.0.0.1:$(cut -d' ' -f2 "$tmp/ports" | tr -d '\n')"

  expect_rc() { # <exit code> <text the output must contain> <label> <command...>
    local want="$1" needle="$2" label="$3" rc=0
    shift 3
    ("$@") >"$tmp/out" 2>&1 || rc=$?
    if [ "$rc" = "$want" ] && grep -qF -- "$needle" "$tmp/out" && ! grep -qF -- "$planted" "$tmp/out"; then
      echo "  ok    $label → exit $rc, $needle"
    else
      echo "  WRONG $label → exit $rc, expected exit $want with '$needle' and no planted token in the output"
      sed 's/^/        /' "$tmp/out"
      failures=$((failures + 1))
    fi
  }
  expect_rc 0 "files-host: PASS" "the Worker's bare 404" cmd_files_host "$base/ok" 1 0
  expect_rc 10 "WORKER-MISCONFIGURED" "200 SPA shell" cmd_files_host "$base/spa" 1 0
  expect_rc 10 "WORKER-MISCONFIGURED" "404 as HTML" cmd_files_host "$base/html404" 1 0
  expect_rc 10 "the response sets a cookie" "404 with a cookie (value not printed)" cmd_files_host "$base/cookie" 1 0
  expect_rc 10 "WORKER-MISCONFIGURED" "the Worker's own 403" cmd_files_host "$base/worker403" 1 0
  expect_rc 10 "status '301'" "a redirect (not followed)" cmd_files_host "$base/redirect" 1 0
  expect_rc 10 "WORKER-MISCONFIGURED" "403 HTML with NO challenge marker (ambiguous → the dangerous verdict)" cmd_files_host "$base/block" 1 0
  expect_rc 11 "EDGE-CHALLENGE" "403 challenge page (cf-mitigated: challenge)" cmd_files_host "$base/challenge" 1 0
  expect_rc 11 "Bot Fight Mode" "the challenge verdict names the dashboard setting" cmd_files_host "$base/challenge" 1 0
  expect_rc 11 "Just a moment..." "the challenge page's title is shown" cmd_files_host "$base/challenge" 1 0
  expect_rc 11 "EDGE-CHALLENGE" "a 404 text/plain with the challenge marker is not a pass" cmd_files_host "$base/challenge404" 1 0
  expect_rc 10 "<redacted>" "a token in the body is redacted" cmd_files_host "$base/leak" 1 0
  expect_rc 10 "not a text content-type, not shown" "a binary body is not printed" cmd_files_host "$base/binary" 1 0
  expect_rc 12 "UNREACHABLE" "nothing listening" cmd_files_host "$dead/" 2 0
  expect_rc 12 "UNREACHABLE" "the connection is dropped without an answer" cmd_files_host "$base/no-such-route" 1 0
  # The control for expect_rc itself: the planted token must be detectable when it IS printed.
  leak_control() { echo "files-host: PASS $planted"; }
  if ("leak_control") >"$tmp/out" 2>&1 && grep -qF -- "$planted" "$tmp/out"; then echo "  ok    control: a printed token is detected"; else
    echo "  WRONG control: the planted token was not detected"
    failures=$((failures + 1))
  fi
  kill "$stub_pid" 2>/dev/null || true

  echo "utc-zone (the verdict on the query's rows):"
  utc_rows() { printf '%s\n' "$@" >"$tmp/utc.rows" && eval_utc_zone "$tmp/utc.rows"; }
  expect pass "Etc/UTC from the server configuration" utc_rows "session:configuration file|Etc/UTC|0|0|holdfast"
  expect pass "GMT, set on the database" utc_rows "session:database|GMT|0|0|neondb" "setting:database|GMT|0|0|neondb"
  expect fail "America/Chicago" utc_rows "session:database|America/Chicago|-21600|-18000|holdfast"
  expect fail "Europe/London (UTC in January only)" utc_rows "session:database|Europe/London|0|3600|holdfast"
  expect fail "a zone that is UTC in July only" utc_rows "session:configuration file|Atlantic/Azores|-3600|0|holdfast"
  expect fail "UTC session, but another role is pinned to Tokyo" utc_rows "session:configuration file|Etc/UTC|0|0|holdfast" "setting:role-in-database|Asia/Tokyo|32400|32400|holdfast"
  expect fail "the connection set its own zone (PGOPTIONS / options=)" utc_rows "session:client|UTC|0|0|holdfast"
  expect fail "no session row" utc_rows "setting:database|UTC|0|0|holdfast"
  expect fail "an error instead of rows" utc_rows 'psql: error: connection to server failed'
  expect fail "offsets missing" utc_rows "session:database|UTC|||holdfast"
  : >"$tmp/utc.empty"
  expect fail "empty output" eval_utc_zone "$tmp/utc.empty"
  expect fail "no output file" eval_utc_zone "$tmp/utc.absent"
  scrubs() { [ "$(scrub_connection 'connection to server at "ep-x.neon.tech" (203.0.113.7), port 5432 failed: password authentication failed for user "owner_a" pw=hunter2secret' 'postgresql://owner_a:hunter2secret@ep-x.neon.tech:5432/neondb?sslmode=require')" = 'connection to server at "<host>" (<address>), port 5432 failed: password authentication failed for user "<user>" pw=<password>' ]; }
  expect pass "host, user and password are taken out of a psql error" scrubs
  expect fail "no DATABASE_URL_DIRECT → not checked" env -u DATABASE_URL_DIRECT bash "${BASH_SOURCE[0]}" utc-zone
  expect fail "DATABASE_URL_DIRECT that is not a postgres URL → not checked" env DATABASE_URL_DIRECT=mysql://localhost/x bash "${BASH_SOURCE[0]}" utc-zone

  echo "redaction:"
  redacts() { [ "$(printf 'error connecting to postgresql://user:pw@ep-x.neon.tech/neondb?sslmode=require now\n' | redact)" = "error connecting to <database-url> now" ]; }
  expect pass "a database URL in tool output is replaced" redacts

  if [ "$failures" -gt 0 ]; then fail "self-test: $failures evaluator(s) gave the wrong verdict"; fi
  echo "self-test: OK"
}

command="${1:-}"
[ "$#" -gt 0 ] && shift
case "$command" in
  dev-vars) cmd_dev_vars "$@" ;;
  built-env) cmd_built_env "$@" ;;
  stamp) cmd_stamp "$@" ;;
  health) cmd_health "$@" ;;
  files-host) cmd_files_host "$@" ;;
  branch-head) cmd_branch_head "$@" ;;
  containers-plan) cmd_containers_plan "$@" ;;
  live-migration-rule) cmd_live_migration_rule "$@" ;;
  worker-ready) cmd_worker_ready "$@" ;;
  secrets) cmd_secrets "$@" ;;
  utc-zone) cmd_utc_zone "$@" ;;
  migrate) cmd_migrate "$@" ;;
  utc-zone-self-test) cmd_utc_zone_self_test "$@" ;;
  self-test) cmd_self_test "$@" ;;
  *)
    sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
