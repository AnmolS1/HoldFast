#!/usr/bin/env bash
# Gate A — "the infrastructure is provisioned and the dev deploy is real".
#
#   DOCKER_CONTEXT=desktop-linux bash scripts/verify-gate-a.sh    # the gate (run on origin/dev's head)
#   bash scripts/verify-gate-a.sh --self-test                     # every evaluator fails on bad input
#   bash scripts/verify-gate-a.sh --static-only [--root DIR]      # the file checks only; never a gate result
#
# The gate stops at the first failure and exits non-zero. It exits 0 only when every check ran and
# passed: a check that could not run, found nothing to compare, or was skipped is a failure. It
# prints names, counts and booleans — never a secret value, a connection string or a `vars` table.
#
# The dry-run builds need Docker (they build the scanner image). On the Mac the active docker
# context is a remote daemon, so prefix the command with DOCKER_CONTEXT=desktop-linux and have
# Docker Desktop running. Also needed: a wrangler login, a neonctl login, `gh` and `psql`.
set -euo pipefail

export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lib="$root/.github/workflows/lib/deploy-lib.sh"

APP_URL="https://holdfast-dev.ponderance.dev"
FILES_URL="https://dev.holdfastusercontent.com"
DEV_WORKER="holdfast-dev"
NEON_PROJECT="old-scene-29128384"
NEON_BRANCH="dev"
# Pinned: the gate must not run whatever version is newest on the day.
NEONCTL_VERSION="8.3.0"
C2_TEST="tests/unit/auth/c2-preseed.test.ts"
C2_SCRIPT="scripts/c2-abort-test.mjs"
# The only keys the client bundle may write to localStorage. Extend only with a reviewed reason.
ALLOWED_STORAGE_KEYS="hf.prefs.v1"
# Storage writes whose key is NOT a string literal in the built bundle (a constant the minifier
# did not inline, or third-party code such as the UI library's colour-mode store). The scan cannot
# read those keys, so a person does: the gate prints every such site, and this is the number of
# sites that have been read and found to store no token, cookie value or session id. Any other
# number — more OR fewer — fails until they are read again. 0 = none reviewed yet.
REVIEWED_NONLITERAL_STORAGE_SITES=0
OUTBOX_MARKER="_test/outbox"
# The number of live checks the gate must complete. A run that completes fewer cannot pass.
EXPECTED_CHECKS=14

json_tail() { awk 'found || /^[[:space:]]*[\[{]/ { found = 1; print }'; }

# ── evaluators: pure functions of a file or directory, exercised by --self-test ──────────────────

eval_todo() { # <wrangler config>
  local file="$1" hits
  [ -f "$file" ] || { echo "TODO_ sentinel: $file does not exist" && return 1; }
  hits="$(grep -c 'TODO_' "$file" || true)"
  if [ "$hits" != "0" ]; then
    echo "TODO_ sentinel: $hits line(s) of $(basename "$file") still contain TODO_"
    return 1
  fi
  echo "TODO_ sentinel: none in $(basename "$file")"
}

eval_c2_files() { # <tree root> — reports both, so one run names everything that is missing
  local tree="$1" bad=0
  if [ -f "$tree/$C2_TEST" ]; then echo "C2 identity test present: $C2_TEST"; else
    echo "C2 identity test missing: $C2_TEST"
    bad=1
  fi
  if [ -f "$tree/$C2_SCRIPT" ]; then echo "C2 script present: $C2_SCRIPT"; else
    echo "C2 script missing: $C2_SCRIPT"
    bad=1
  fi
  return "$bad"
}

eval_hyperdrive() { # <file with `wrangler hyperdrive get <id>` output>
  local file="$1" disabled
  disabled="$(json_tail <"$file" | jq -r 'if (.caching | type) == "object" then (.caching.disabled | tostring) else "unreadable" end' 2>/dev/null)" || disabled="unreadable"
  if [ "$disabled" != "true" ]; then
    echo "hyperdrive: caching.disabled is '$disabled', expected true"
    return 1
  fi
  echo "hyperdrive: caching.disabled = true"
}

eval_run() { # <file with `gh run list --json headSha,status,conclusion,databaseId`> <sha>
  local file="$1" sha="$2" row status conclusion
  row="$(jq -c --arg sha "$sha" 'if type == "array" then [.[] | select(.headSha == $sha)] | first // empty else empty end' "$file" 2>/dev/null)" || row=""
  if [ -z "$row" ]; then
    echo "deploy-dev run: no run found for commit $sha"
    return 1
  fi
  status="$(printf '%s' "$row" | jq -r '.status // ""')"
  conclusion="$(printf '%s' "$row" | jq -r '.conclusion // ""')"
  if [ "$status" != "completed" ] || [ "$conclusion" != "success" ]; then
    echo "deploy-dev run: the latest run for $sha is status='$status' conclusion='$conclusion', expected completed/success"
    return 1
  fi
  echo "deploy-dev run: run $(printf '%s' "$row" | jq -r '.databaseId // "?"') for $sha concluded success"
}

eval_vitest() { # <vitest --reporter=json output file>
  local file="$1" total passed failed
  total="$(jq -r '.numTotalTests // "x"' "$file" 2>/dev/null)" || total="x"
  passed="$(jq -r '.numPassedTests // "x"' "$file" 2>/dev/null)" || passed="x"
  failed="$(jq -r '.numFailedTests // "x"' "$file" 2>/dev/null)" || failed="x"
  if ! [[ "$total" =~ ^[0-9]+$ && "$passed" =~ ^[0-9]+$ && "$failed" =~ ^[0-9]+$ ]]; then
    echo "C2 identity test: the test report could not be read"
    return 1
  fi
  if [ "$total" -lt 1 ]; then
    echo "C2 identity test: the run reports 0 tests"
    return 1
  fi
  if [ "$failed" != "0" ] || [ "$passed" != "$total" ]; then
    echo "C2 identity test: $passed of $total passed, $failed failed (skipped tests count as not passed)"
    return 1
  fi
  echo "C2 identity test: $passed of $total passed"
}

eval_storage_keys() { # <built client directory>
  local dir="$1"
  [ -d "$dir" ] || { echo "bundle-hygiene: $dir does not exist (no build)" && return 1; }
  ALLOWED="$ALLOWED_STORAGE_KEYS" REVIEWED="$REVIEWED_NONLITERAL_STORAGE_SITES" node - "$dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const allowed = new Set((process.env.ALLOWED || "").split(/\s+/).filter(Boolean));
const reviewed = Number(process.env.REVIEWED || "0");
const nonLiteral = [];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(e.name)) files.push(p);
  }
})(dir);
const problems = [];
let sites = 0;
const seen = new Set();
let all = "";
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  all += src;
  // Every Storage write. The receiver cannot be told apart in minified code, so sessionStorage
  // writes are held to the same list.
  for (const m of src.matchAll(/\.setItem\(\s*/g)) {
    sites++;
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const lit = rest.match(/^(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/);
    const where = `${path.relative(dir, file)}@${m.index}`;
    if (lit && !lit[2].includes("${")) {
      seen.add(lit[2]);
      if (!allowed.has(lit[2])) problems.push(`${where}: writes the key "${lit[2]}", which is not allow-listed`);
    } else {
      const context = src.slice(Math.max(0, m.index - 60), m.index + 100).replace(/\s+/g, " ");
      nonLiteral.push(`${where}: …${context}…`);
    }
  }
}
if (files.length === 0) problems.push("no JavaScript files in the client build");
for (const key of allowed) {
  // Proof that this is the real client and the list is current: an allow-listed key nobody
  // writes means the check looked at the wrong bundle or the key was renamed.
  if (!all.includes(key)) problems.push(`the allow-listed key "${key}" does not occur in the client bundle (wrong bundle, or the key was renamed)`);
}
console.log(`bundle-hygiene: ${files.length} client file(s), ${sites} Storage write site(s), literal keys: ${[...seen].sort().join(", ") || "(none)"}; ${nonLiteral.length} site(s) with a non-literal key, ${reviewed} reviewed`);
if (nonLiteral.length !== reviewed) {
  problems.push(`${nonLiteral.length} Storage write site(s) have a key the scan cannot read, but ${reviewed} were reviewed — read each one below, then set REVIEWED_NONLITERAL_STORAGE_SITES`);
  for (const site of nonLiteral) problems.push(`  site: ${site}`);
}
for (const p of problems) console.log(`bundle-hygiene: ${p}`);
process.exit(problems.length ? 1 : 0);
NODE
}

eval_outbox_gate() { # <built Worker directory>
  local dir="$1" files refs guards
  [ -d "$dir" ] || { echo "bundle-hygiene: $dir does not exist (no build)" && return 1; }
  files="$(find "$dir" -type f \( -name '*.js' -o -name '*.mjs' \) | wc -l | tr -d ' ')"
  refs="$( (find "$dir" -type f \( -name '*.js' -o -name '*.mjs' \) -exec cat {} + 2>/dev/null || true) | grep -o "$OUTBOX_MARKER" | wc -l | tr -d ' ')"
  guards="$( (find "$dir" -type f \( -name '*.js' -o -name '*.mjs' \) -exec cat {} + 2>/dev/null || true) | grep -o 'EMAIL_TRANSPORT' | wc -l | tr -d ' ')"
  echo "bundle-hygiene: $files Worker file(s), $refs reference(s) to the memory outbox route, $guards to EMAIL_TRANSPORT"
  if [ "$refs" = "0" ]; then
    echo "bundle-hygiene: the Worker bundle has no '$OUTBOX_MARKER' route — nothing to check (wrong bundle, or the route moved)"
    return 1
  fi
  if [ "$guards" = "0" ]; then
    echo "bundle-hygiene: the memory outbox is in the Worker bundle but EMAIL_TRANSPORT is not — nothing gates it"
    return 1
  fi
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────────
self_test() {
  local tmp failures=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-gate-a-selftest.XXXXXX")"
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
  local sha="1111111111111111111111111111111111111111" other="2222222222222222222222222222222222222222"

  echo "TODO_ sentinel:"
  printf '{ "name": "holdfast-dev" }\n' >"$tmp/clean.jsonc"
  printf '{ "name": "holdfast-dev", "id": "TODO_HYPERDRIVE_ID" }\n' >"$tmp/todo.jsonc"
  expect pass "clean config" eval_todo "$tmp/clean.jsonc"
  expect fail "config with a planted TODO_" eval_todo "$tmp/todo.jsonc"
  expect fail "config missing" eval_todo "$tmp/absent.jsonc"

  echo "C2 files:"
  mkdir -p "$tmp/both/$(dirname "$C2_TEST")" "$tmp/both/$(dirname "$C2_SCRIPT")" "$tmp/only-script/$(dirname "$C2_SCRIPT")" "$tmp/only-test/$(dirname "$C2_TEST")" "$tmp/neither"
  : >"$tmp/both/$C2_TEST" && : >"$tmp/both/$C2_SCRIPT" && : >"$tmp/only-script/$C2_SCRIPT" && : >"$tmp/only-test/$C2_TEST"
  expect pass "both present" eval_c2_files "$tmp/both"
  expect fail "identity test missing" eval_c2_files "$tmp/only-script"
  expect fail "abort script missing" eval_c2_files "$tmp/only-test"
  expect fail "both missing" eval_c2_files "$tmp/neither"

  echo "hyperdrive:"
  printf ' ⛅️ wrangler\n{\n  "id": "x",\n  "caching": { "disabled": true }\n}\n' >"$tmp/hd-off.txt"
  echo '{"id":"x","caching":{"disabled":false,"max_age":60}}' >"$tmp/hd-on.txt"
  echo '{"id":"x","caching":{}}' >"$tmp/hd-default.txt"
  echo '{"id":"x"}' >"$tmp/hd-nokey.txt"
  echo 'Authentication error' >"$tmp/hd-error.txt"
  expect pass "caching disabled" eval_hyperdrive "$tmp/hd-off.txt"
  expect fail "caching enabled" eval_hyperdrive "$tmp/hd-on.txt"
  expect fail "caching block without 'disabled' (default = on)" eval_hyperdrive "$tmp/hd-default.txt"
  expect fail "no caching block" eval_hyperdrive "$tmp/hd-nokey.txt"
  expect fail "an error instead of a config" eval_hyperdrive "$tmp/hd-error.txt"

  echo "deploy-dev run:"
  echo "[{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"success\",\"databaseId\":7}]" >"$tmp/run-ok.json"
  echo "[{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"failure\",\"databaseId\":7}]" >"$tmp/run-failed.json"
  echo "[{\"headSha\":\"$sha\",\"status\":\"in_progress\",\"conclusion\":\"\",\"databaseId\":7}]" >"$tmp/run-running.json"
  echo "[{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"failure\",\"databaseId\":9},{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"success\",\"databaseId\":7}]" >"$tmp/run-rerun-failed.json"
  echo "[{\"headSha\":\"$other\",\"status\":\"completed\",\"conclusion\":\"success\",\"databaseId\":7}]" >"$tmp/run-other.json"
  echo "[]" >"$tmp/run-none.json"
  expect pass "success for this commit" eval_run "$tmp/run-ok.json" "$sha"
  expect fail "failure for this commit" eval_run "$tmp/run-failed.json" "$sha"
  expect fail "still running" eval_run "$tmp/run-running.json" "$sha"
  expect fail "newest run for the commit failed, an older one passed" eval_run "$tmp/run-rerun-failed.json" "$sha"
  expect fail "green run, but for another commit" eval_run "$tmp/run-other.json" "$sha"
  expect fail "no runs at all" eval_run "$tmp/run-none.json" "$sha"

  echo "C2 identity test report:"
  echo '{"numTotalTests":3,"numPassedTests":3,"numFailedTests":0}' >"$tmp/vt-ok.json"
  echo '{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0}' >"$tmp/vt-zero.json"
  echo '{"numTotalTests":3,"numPassedTests":2,"numFailedTests":1}' >"$tmp/vt-failed.json"
  echo '{"numTotalTests":3,"numPassedTests":2,"numFailedTests":0,"numPendingTests":1}' >"$tmp/vt-skipped.json"
  echo 'No test files found' >"$tmp/vt-garbage.json"
  expect pass "3 of 3" eval_vitest "$tmp/vt-ok.json"
  expect fail "0 tests" eval_vitest "$tmp/vt-zero.json"
  expect fail "one failed" eval_vitest "$tmp/vt-failed.json"
  expect fail "one skipped" eval_vitest "$tmp/vt-skipped.json"
  expect fail "not a report" eval_vitest "$tmp/vt-garbage.json"

  echo "bundle-hygiene, localStorage keys:"
  mkdir -p "$tmp/c-ok/assets" "$tmp/c-token/assets" "$tmp/c-dynamic/assets" "$tmp/c-stale/assets" "$tmp/c-empty"
  echo 'function p(v){localStorage.setItem("hf.prefs.v1",JSON.stringify(v))}' >"$tmp/c-ok/assets/index.js"
  echo 'function p(v){localStorage.setItem("hf.prefs.v1",v);localStorage.setItem("hf.session",t)}' >"$tmp/c-token/assets/index.js"
  echo 'function p(v){localStorage.setItem("hf.prefs.v1",v);window.localStorage.setItem(k+"-mode",m)}' >"$tmp/c-dynamic/assets/index.js"
  echo 'function p(v){localStorage.setItem("hf.prefs.v2",v)}' >"$tmp/c-stale/assets/index.js"
  expect pass "only the allow-listed key" eval_storage_keys "$tmp/c-ok"
  expect fail "a second, unlisted key" eval_storage_keys "$tmp/c-token"
  expect fail "a key that is not a string literal" eval_storage_keys "$tmp/c-dynamic"
  expect fail "the allow-listed key is not in the bundle" eval_storage_keys "$tmp/c-stale"
  expect fail "empty build" eval_storage_keys "$tmp/c-empty"
  expect fail "no build" eval_storage_keys "$tmp/c-absent"
  REVIEWED_NONLITERAL_STORAGE_SITES=1 expect pass "one non-literal site, one reviewed" eval_storage_keys "$tmp/c-dynamic"
  REVIEWED_NONLITERAL_STORAGE_SITES=2 expect fail "one non-literal site, two reviewed (the bundle changed)" eval_storage_keys "$tmp/c-dynamic"
  REVIEWED_NONLITERAL_STORAGE_SITES=1 expect fail "no non-literal site, one reviewed (the bundle changed)" eval_storage_keys "$tmp/c-ok"

  echo "bundle-hygiene, memory outbox:"
  mkdir -p "$tmp/w-ok" "$tmp/w-ungated" "$tmp/w-none"
  echo 'if(env.EMAIL_TRANSPORT==="memory")app.get("/api/_test/outbox",h)' >"$tmp/w-ok/index.js"
  echo 'app.get("/api/_test/outbox",h)' >"$tmp/w-ungated/index.js"
  echo 'app.get("/api/health",h)' >"$tmp/w-none/index.js"
  expect pass "outbox route with EMAIL_TRANSPORT in the bundle" eval_outbox_gate "$tmp/w-ok"
  expect fail "outbox route, no EMAIL_TRANSPORT" eval_outbox_gate "$tmp/w-ungated"
  expect fail "no outbox route found (nothing compared)" eval_outbox_gate "$tmp/w-none"
  expect fail "no build" eval_outbox_gate "$tmp/w-absent"

  if [ "$failures" -gt 0 ]; then
    echo "verify-gate-a --self-test: $failures evaluator(s) gave the wrong verdict" >&2
    exit 1
  fi
  echo "verify-gate-a --self-test: OK"
}

# ── static checks: files only, no network ────────────────────────────────────────────────────────
static_checks() { # <tree root> — runs all of them and reports every failure
  local tree="$1" bad=0
  eval_todo "$tree/wrangler.jsonc" || bad=1
  eval_c2_files "$tree" || bad=1
  return "$bad"
}

# ── the gate ─────────────────────────────────────────────────────────────────────────────────────
checks_done=0
tree_is_production=0

step() { # <name> <command...> — stop at the first failure
  local name="$1"
  shift
  echo "── $name"
  if "$@"; then
    checks_done=$((checks_done + 1))
    echo "PASS  $name"
  else
    echo "FAIL  $name" >&2
    echo "GATE A: FAIL (stopped at: $name; $checks_done of $EXPECTED_CHECKS checks had passed)" >&2
    exit 1
  fi
}

# wrangler prints every `vars` value in its binding table. Its output is kept in a file and only
# the lines that are not bindings are shown, and only when the command failed.
quiet() { # <log file> <command...>
  local log="$1"
  shift
  if "$@" >"$log" 2>&1; then return 0; fi
  echo "   (command failed; output without the bindings table follows)"
  grep -v -E '^[[:space:]]*(env\.|Binding[[:space:]])' "$log" | grep -v -E 'postgres(ql)?://' | tail -n 25 | sed 's/^/   | /'
  return 1
}

restore_dev_build() {
  if [ "$tree_is_production" = "1" ]; then
    echo "restoring a dev build (the tree was left pointing at production)…" >&2
    (cd "$root" && npm run --silent build >/dev/null 2>&1) || echo "WARNING: could not rebuild dev — run 'npm run build' before any deploy" >&2
  fi
}

check_tools() {
  local tool missing=""
  for tool in git jq curl node npx npm psql gh docker; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [ -z "$missing" ] || { echo "missing tools:$missing" && return 1; }
  [ -x "$lib" ] || [ -f "$lib" ] || { echo "missing $lib" && return 1; }
  docker info >/dev/null 2>&1 || { echo "Docker is not reachable (the dry-run builds the scanner image). On the Mac: start Docker Desktop and prefix with DOCKER_CONTEXT=desktop-linux" && return 1; }
  echo "tools present; Docker reachable"
}

check_checkout() {
  git -C "$root" fetch --quiet origin dev || { echo "could not fetch origin/dev" && return 1; }
  dev_sha="$(git -C "$root" rev-parse origin/dev)"
  local head dirty
  head="$(git -C "$root" rev-parse HEAD)"
  if [ "$head" != "$dev_sha" ]; then
    echo "this checkout is at $head, origin/dev is at $dev_sha — the gate is about origin/dev's head"
    return 1
  fi
  dirty="$(git -C "$root" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  [ "$dirty" = "0" ] || { echo "$dirty tracked file(s) have uncommitted changes — the gate must run on the committed tree" && return 1; }
  echo "checkout == origin/dev == $dev_sha, clean"
}

check_whoami() {
  (cd "$root" && npx wrangler whoami >/dev/null 2>&1) || { echo "wrangler is not logged in" && return 1; }
  echo "wrangler is authenticated (identity not printed)"
}

check_builds() {
  local emitted="$root/dist/holdfast_dev/wrangler.json"
  cd "$root"
  quiet "$tmpdir/build-dev.log" npm run build || return 1
  bash "$lib" built-env dev || return 1
  hyperdrive_dev="$(jq -r '.hyperdrive[0].id // ""' "$emitted")"
  quiet "$tmpdir/dry-dev.log" npx wrangler deploy --dry-run || return 1
  echo "dev: build + dry-run OK"

  tree_is_production=1
  quiet "$tmpdir/build-prod.log" env CLOUDFLARE_ENV=production npx vite build || return 1
  bash "$lib" built-env production || return 1
  hyperdrive_prod="$(jq -r '.hyperdrive[0].id // ""' "$emitted")"
  quiet "$tmpdir/dry-prod.log" npx wrangler deploy --dry-run --env production || return 1
  echo "production: build + dry-run OK"

  # Finish on a dev build so the tree does not stay pointed at production.
  quiet "$tmpdir/build-dev-2.log" npm run build || return 1
  bash "$lib" built-env dev || return 1
  tree_is_production=0
  [ -n "$hyperdrive_dev" ] && [ -n "$hyperdrive_prod" ] && [ "$hyperdrive_dev" != "$hyperdrive_prod" ] ||
    { echo "the two builds did not yield two different Hyperdrive ids" && return 1; }
}

check_deploy() {
  bash "$lib" health "$APP_URL" || return 1
  bash "$lib" stamp "$APP_URL" "$dev_sha" 3 5 || return 1
  bash "$lib" files-host "$FILES_URL/" || return 1
}

# The dev branch's DIRECT connection string, fetched once. Held in a variable, handed over in the
# environment, never printed.
fetch_neon_url() {
  [ -z "$neon_url" ] || return 0
  neon_url="$(cd "$root" && npx --yes "neonctl@$NEONCTL_VERSION" connection-string "$NEON_BRANCH" --project-id "$NEON_PROJECT" 2>/dev/null)" || neon_url=""
  [ -n "$neon_url" ] || { echo "could not fetch the Neon $NEON_BRANCH connection string (neonctl login?)" && return 1; }
}

# Live, against the Neon dev branch: zero UTC offset in January and July for a new session and
# for every stored database/role setting (the auth tables' DEFAULT now() depends on it).
check_utc_zone() {
  fetch_neon_url || return 1
  DATABASE_URL_DIRECT="$neon_url" bash "$lib" utc-zone
}

check_migrations() {
  fetch_neon_url || return 1
  DATABASE_URL_DIRECT="$neon_url" bash "$lib" migrate none-pending remote
}

check_secrets() { bash "$lib" secrets "$DEV_WORKER"; }

check_hyperdrive() {
  local id
  for id in "$hyperdrive_dev" "$hyperdrive_prod"; do
    (cd "$root" && npx wrangler hyperdrive get "$id") >"$tmpdir/hyperdrive.txt" 2>/dev/null ||
      { echo "hyperdrive: 'wrangler hyperdrive get' failed for one of the two configs" && return 1; }
    eval_hyperdrive "$tmpdir/hyperdrive.txt" || return 1
  done
  echo "hyperdrive: both configs (dev, production) have caching disabled"
}

check_run() {
  (cd "$root" && gh run list --workflow deploy-dev.yml --branch dev --limit 40 --json headSha,status,conclusion,databaseId) >"$tmpdir/runs.json" 2>/dev/null ||
    { echo "deploy-dev run: 'gh run list' failed" && return 1; }
  eval_run "$tmpdir/runs.json" "$dev_sha"
}

check_c2_identity() {
  cd "$root"
  [ -f "$C2_TEST" ] || { echo "C2 identity test missing: $C2_TEST" && return 1; }
  rm -f "$tmpdir/c2.json"
  # Exit status and report are both required: zero tests, a skip or an unreadable report fail.
  npx vitest run -c vitest.workers.config.ts "$C2_TEST" --reporter=json --outputFile="$tmpdir/c2.json" >"$tmpdir/c2.log" 2>&1 ||
    { echo "C2 identity test: vitest exited non-zero" && tail -n 15 "$tmpdir/c2.log" | sed 's/^/   | /' && return 1; }
  [ -s "$tmpdir/c2.json" ] || { echo "C2 identity test: vitest wrote no report" && return 1; }
  eval_vitest "$tmpdir/c2.json"
}

check_c2_abort() {
  cd "$root"
  [ -f "$C2_SCRIPT" ] || { echo "C2 script missing: $C2_SCRIPT" && return 1; }
  # Supplementary: a timeout or 5xx is a real hang and fails the gate; a pass alone proves nothing.
  npm run --silent test:c2 -- "$APP_URL" || { echo "C2 abort test failed against $APP_URL" && return 1; }
  echo "C2 abort test exited 0 against $APP_URL (supplementary evidence)"
}

check_bundle() {
  eval_storage_keys "$root/dist/client" || return 1
  eval_outbox_gate "$root/dist/holdfast_dev" || return 1
  # And the deploy itself: the outbox route must not exist on a Worker whose transport is not memory.
  local status
  status="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$APP_URL/api/$OUTBOX_MARKER" 2>/dev/null)" || status="none"
  [ "$status" = "404" ] || { echo "bundle-hygiene: GET $APP_URL/api/$OUTBOX_MARKER answered $status, expected 404" && return 1; }
  echo "bundle-hygiene: the dev deploy answers 404 on the memory outbox route"
}

gate() {
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-gate-a.XXXXXX")"
  # shellcheck disable=SC2064
  trap "restore_dev_build; rm -rf '$tmpdir'" EXIT
  dev_sha="" hyperdrive_dev="" hyperdrive_prod="" neon_url=""

  # Offline first, all reported together: nothing below is worth running on a tree like that.
  echo "── static checks"
  if ! static_checks "$root"; then
    echo "FAIL  static checks" >&2
    echo "GATE A: FAIL (static checks; no live check was run)" >&2
    exit 1
  fi
  echo "PASS  static checks"

  step "tools" check_tools
  step "checkout is origin/dev" check_checkout
  step "wrangler whoami" check_whoami
  step "both environments build and dry-run with the right names" check_builds
  step "dev deploy: health, build stamp, files host" check_deploy
  step "the Neon dev branch keeps UTC time (January and July)" check_utc_zone
  step "migrations applied on the Neon dev branch (re-run applies 0)" check_migrations
  step "the nine secrets are on the dev Worker" check_secrets
  step "Hyperdrive caching disabled on both configs" check_hyperdrive
  step "deploy-dev run for origin/dev's head concluded success" check_run
  step "C2: storage-identity test" check_c2_identity
  step "C2: abort test on the dev deploy (supplementary)" check_c2_abort
  step "bundle-hygiene" check_bundle
  step "no TODO_ in the emitted dev config" eval_todo "$root/dist/holdfast_dev/wrangler.json"

  if [ "$checks_done" != "$EXPECTED_CHECKS" ]; then
    echo "GATE A: FAIL ($checks_done checks completed, $EXPECTED_CHECKS expected — a check was skipped)" >&2
    exit 1
  fi
  echo "GATE A: PASS ($checks_done of $EXPECTED_CHECKS checks, commit $dev_sha)"
  echo "Report alongside this output: Google sign-in on the dev deploy, the C2 mutant control, and what is still human-gated."
}

mode="gate"
static_root="$root"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test) mode="self-test" ;;
    --static-only) mode="static" ;;
    --root)
      [ "$#" -ge 2 ] || { echo "--root needs a directory" >&2 && exit 2; }
      static_root="$2"
      mode="static"
      shift
      ;;
    -h | --help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "verify-gate-a: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
  shift
done

case "$mode" in
  self-test) self_test ;;
  static)
    command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2 && exit 1; }
    echo "── static checks on $static_root"
    if static_checks "$static_root"; then
      # Deliberately not 0: a run that skipped every live check must never be mistaken for the gate.
      echo "STATIC CHECKS PASS — this is NOT a Gate A result (no live check was run)"
      exit 3
    fi
    echo "GATE A: FAIL (static checks)" >&2
    exit 1
    ;;
  gate) gate ;;
esac
