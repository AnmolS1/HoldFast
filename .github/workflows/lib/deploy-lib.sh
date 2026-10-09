#!/usr/bin/env bash
# Shared checks for the deploy workflows and scripts/verify-gate-a.sh. One implementation of each
# rule, so the workflows and the gate cannot drift apart.
#
#   deploy-lib.sh dev-vars [root] [port]             write a CI .dev.vars with fresh generated secrets
#   deploy-lib.sh built-env <dev|production> [file]  which environment did the last build emit?
#   deploy-lib.sh stamp <base-url> <sha> [tries] [sleep]   GET /__meta commit == sha
#   deploy-lib.sh health <base-url>                  GET /api/health is 200 {"ok":true}
#   deploy-lib.sh files-host <url>                   HEAD is 404 text/plain, no set-cookie
#   deploy-lib.sh branch-head <branch> <sha>         sha is still the head of origin/<branch>
#   deploy-lib.sh containers-plan <base-url> <sha>   build the scanner image, or leave containers alone?
#   deploy-lib.sh worker-ready <worker>              the Worker exists, has a deployment and its secrets
#   deploy-lib.sh secrets <worker>                   the Worker has the nine secret names
#   deploy-lib.sh migrate <apply|none-pending> <local|remote>   drizzle migrations, counted
#   deploy-lib.sh self-test                          every evaluator fails on bad input, passes on good
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

# ── stamp / health / files-host ──────────────────────────────────────────────────────────────────
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

# <response headers> → 0 when they are the files host's bare 404.
eval_files_head() {
  local headers status ctype bad=0
  headers="$(printf '%s' "$1" | tr -d '\r')"
  status="$(printf '%s\n' "$headers" | awk 'NR == 1 { print $2 }')"
  ctype="$(printf '%s\n' "$headers" | awk 'tolower($1) == "content-type:" { print tolower($2) }' | tr -d ';')"
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
  [ "$bad" = 0 ] && echo "files-host: 404, text/plain, no set-cookie"
  return "$bad"
}

cmd_files_host() {
  [ "$#" -ge 1 ] || fail "usage: deploy-lib.sh files-host <url>"
  need curl
  local url="$1" headers="" i=1
  while [ "$i" -le 3 ]; do
    headers="$(curl -sS -I --max-time 15 "$url" 2>/dev/null)" && [ -n "$headers" ] && break
    headers=""
    sleep 5
    i=$((i + 1))
  done
  [ -n "$headers" ] || fail "files-host: no answer from $url"
  eval_files_head "$headers" || fail "files-host: $url is not the bare files host"
  echo "files-host: OK ($url)"
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

  echo "files-host:"
  expect pass "bare 404" eval_files_head "$(printf 'HTTP/2 404 \r\ncontent-type: text/plain; charset=utf-8\r\ncache-control: no-store\r\n')"
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
  repo_root="$saved_root"

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
  worker-ready) cmd_worker_ready "$@" ;;
  secrets) cmd_secrets "$@" ;;
  migrate) cmd_migrate "$@" ;;
  self-test) cmd_self_test "$@" ;;
  *)
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
