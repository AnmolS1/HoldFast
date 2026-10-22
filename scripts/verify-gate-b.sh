#!/usr/bin/env bash
# Gate B — "the beta can open": the legal set is complete and the deploy is what was verified.
#
#   bash scripts/verify-gate-b.sh                  # the gate against the DEV deploy (read-only)
#   bash scripts/verify-gate-b.sh --prod           # the gate against production (T30, at Gate B)
#   bash scripts/verify-gate-b.sh --self-test      # every evaluator gives the right verdict on made-up input
#   bash scripts/verify-gate-b.sh --local-only     # the file checks only; never a gate result (exit 3)
#   … [--plan DIR]                                 # the plan directory (default: the main checkout's holdfast-plan/)
#
# EVERY check runs, whatever the others did, and prints one line: PASS or FAIL, its id, who owns
# it, and what it compared. The gate exits 0 only when every check of the mode ran and passed; a
# check that could not run, found nothing to compare, or was skipped is a FAIL. The last line says
# how many checks ran against how many the mode expects.
#
# Remote checks are READ-ONLY: GETs to the deploy and to ponderance.dev, `wrangler secret list`,
# `wrangler hyperdrive get`, `wrangler r2 bucket notification list`, `wrangler r2 object get
# --remote --pipe` of the backup manifest, `gh run list`, `git fetch`, and the `@prod-safe`
# Playwright run (it creates nothing and signs in nowhere). Nothing is written anywhere. Output is
# names, counts, booleans and the fields compared — never a secret value, a connection string or a
# wrangler `vars` table. Needs: a wrangler login, `gh` (authenticated), jq, curl, node.
#
# The legal checks read the plan directory (gitignored, so it exists only in the main checkout) and
# the formats below — written by Anmol, never by this script:
#   legal/gate-b-legal.md     a line containing "registered YYYY-MM-DD, renewal YYYY-MM-DD" (DMCA
#                             agent, T29 §B.1) and one containing "NCMEC ESP requested YYYY-MM-DD"
#   legal/residual-risks.md   every numbered row with a date (YYYY-MM-DD) and initials in its last two
#                             cells, and the line "Completed by: <name> on: YYYY-MM-DD"
#   legal/csam-procedure.md   a line of its own "Adopted: YYYY-MM-DD <initials>", and no "not adopted"
#   legal/dmca-procedure.md   the same
#   (--prod) gate-b-report.md the R2-rule probe's evidence lines (T30 step 7):
#                             "probe key: u/_probe/gate-b-<stamp>", "probe first invocation: <n> s",
#                             "probe control invocations: 0"
set -uo pipefail

export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lib="$root/.github/workflows/lib/deploy-lib.sh"

AGENT_FILE="src/client/features/dmca/agent.ts"
HEADER_SNAPSHOT="tests/unit/security/__snapshots__/headers.json"
DMCA_SPEC="tests/e2e/dmca.spec.ts"
# T30 step 5: the nine of Gate A plus T27's Analytics token. (PHOTODNA_SUBSCRIPTION_KEY: only once approved.)
REQUIRED_SECRETS="BETTER_AUTH_SECRET FILES_TOKEN_SECRET IP_ENC_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET RESEND_API_KEY TURNSTILE_SECRET SENTRY_DSN ADMIN_EMAILS CF_ANALYTICS_TOKEN"
# What R2 sends for `--event-type object-create` (T30 step 7).
OBJECT_CREATE_ACTIONS="CompleteMultipartUpload,CopyObject,PutObject"
# Headers Cloudflare's edge adds to a response that the local snapshot cannot have. Any OTHER header
# the deploy sends beyond the snapshot fails the header check (a new header is a reviewed change).
EDGE_HEADERS="server alt-svc nel report-to content-length transfer-encoding connection server-timing speculation-rules"
PONDERANCE="https://ponderance.dev"
DAY_RE='20[0-9][0-9]-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'

json_tail() { awk 'found || /^[[:space:]]*[\[{]/ { found = 1; print }'; }
is_day() { [[ "$1" =~ ^${DAY_RE}$ ]]; }

# ── evaluators: pure functions of files, exercised by --self-test ────────────────────────────────

eval_agent() { # <agent.ts> — T29 §B.2: the four designated-agent fields, no sentinel left
  local file="$1" left
  [ -f "$file" ] || { echo "$file does not exist" && return 1; }
  grep -q 'export const AGENT' "$file" || { echo "$(basename "$file") has no AGENT block (nothing to compare)" && return 1; }
  left="$(grep -c 'TODO_' "$file")"
  if [ "$left" != "0" ]; then
    echo "DMCA agent details not supplied: $left field(s) of $AGENT_FILE still carry the TODO_ sentinel (T29 §B.1 registration, then fill them)"
    return 1
  fi
  echo "no TODO_ sentinel left in $AGENT_FILE"
}

eval_dmca_registered() { # <gate-b-legal.md>
  local file="$1" line reg ren
  [ -s "$file" ] || { echo "$(basename "$file") missing or empty" && return 1; }
  line="$(grep -oE "registered ${DAY_RE}, renewal ${DAY_RE}" "$file" | head -n 1)"
  if [ -z "$line" ]; then
    echo "no \"registered YYYY-MM-DD, renewal YYYY-MM-DD\" line in gate-b-legal.md (DMCA agent registration, T29 §B.1)"
    return 1
  fi
  reg="$(printf '%s' "$line" | awk '{ print $2 }' | tr -d ',')"
  ren="$(printf '%s' "$line" | awk '{ print $4 }')"
  if ! [[ "$ren" > "$reg" ]]; then
    echo "DMCA agent: renewal $ren is not after registration $reg"
    return 1
  fi
  echo "DMCA agent registered $reg, renewal $ren"
}

eval_ncmec() { # <gate-b-legal.md> <today YYYY-MM-DD>
  local file="$1" today="$2" day
  [ -s "$file" ] || { echo "$(basename "$file") missing or empty" && return 1; }
  day="$(grep -oE "NCMEC ESP requested ${DAY_RE}" "$file" | head -n 1 | awk '{ print $4 }')"
  if [ -z "$day" ]; then
    echo "no \"NCMEC ESP requested YYYY-MM-DD\" line in gate-b-legal.md (T29 §C.2)"
    return 1
  fi
  if [[ "$day" > "$today" ]]; then
    echo "NCMEC ESP request dated $day, which is after today ($today)"
    return 1
  fi
  echo "NCMEC ESP requested $day"
}

eval_residual() { # <residual-risks.md> — every row dated and initialled, and the completion line
  local file="$1" rows=0 bad="" line num date initials who on
  [ -s "$file" ] || { echo "$(basename "$file") missing or empty" && return 1; }
  while IFS= read -r line; do
    num="$(printf '%s' "$line" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')"
    date="$(printf '%s' "$line" | awk -F'|' '{ v = $(NF - 2); gsub(/^ +| +$/, "", v); print v }')"
    initials="$(printf '%s' "$line" | awk -F'|' '{ v = $(NF - 1); gsub(/^ +| +$/, "", v); print v }')"
    rows=$((rows + 1))
    if ! is_day "$date" || ! [[ "$initials" =~ ^[A-Za-z][A-Za-z.\ -]{0,15}$ ]]; then bad="$bad $num"; fi
  done < <(grep -E '^\|[[:space:]]*[0-9]+[[:space:]]*\|' "$file")
  if [ "$rows" = "0" ]; then
    echo "no numbered risk rows in residual-risks.md (nothing to compare)"
    return 1
  fi
  line="$(grep -E '^Completed by:' "$file" | head -n 1)"
  who="$(printf '%s' "$line" | sed -nE 's/^Completed by:[[:space:]]*(.*[^[:space:]])[[:space:]]+on:.*/\1/p')"
  on="$(printf '%s' "$line" | sed -nE "s/.*on:[[:space:]]*(${DAY_RE}).*/\1/p")"
  local done_ok=1
  if [ -z "$who" ] || [[ "$who" == *_* ]] || [ -z "$on" ]; then done_ok=0; fi
  if [ -n "$bad" ] || [ "$done_ok" = 0 ]; then
    local msg="residual risks not signed off:"
    [ -n "$bad" ] && msg="$msg row(s)$bad without a date and initials of $rows;"
    [ "$done_ok" = 0 ] && msg="$msg no completed \"Completed by: <name> on: YYYY-MM-DD\" line;"
    echo "${msg%;}"
    return 1
  fi
  echo "all $rows risk rows dated and initialled; completed by $who on $on"
}

eval_adopted() { # <procedure.md>
  local file="$1" line
  [ -s "$file" ] || { echo "$(basename "$file") missing or empty" && return 1; }
  line="$(grep -E "^Adopted: ${DAY_RE} [A-Za-z][A-Za-z.]{0,9}[[:space:]]*$" "$file" | head -n 1)"
  if [ -z "$line" ]; then
    echo "$(basename "$file") has no \"Adopted: YYYY-MM-DD <initials>\" line (HUMAN: read, correct, date and initial it)"
    return 1
  fi
  if grep -qi 'not adopted' "$file"; then
    echo "$(basename "$file") has an Adopted line but still says \"not adopted\" elsewhere (update its status header)"
    return 1
  fi
  echo "$(basename "$file"): ${line}"
}

eval_legal_files() { # <plan dir>
  local plan="$1" missing="" f
  [ -d "$plan/legal" ] || { echo "plan directory $plan/legal not found (run from the main checkout's tree or pass --plan)" && return 1; }
  for f in csam-procedure dmca-procedure residual-risks gate-b-legal; do
    [ -s "$plan/legal/$f.md" ] || missing="$missing $f.md"
  done
  [ -z "$missing" ] || { echo "missing or empty in $plan/legal:$missing" && return 1; }
  echo "the four legal files are present and non-empty"
}

eval_ponderance() { # <dir with privacy.html terms.html support.html, each possibly empty>
  local dir="$1" bad="" page n
  for page in privacy terms support; do
    [ -s "$dir/$page.html" ] || { bad="$bad $page:unreachable" && continue; }
    n="$(grep -o 'Holdfast' "$dir/$page.html" | wc -l | tr -d ' ')"
    [ "$n" -ge 1 ] || bad="$bad $page:no-Holdfast"
  done
  if [ -s "$dir/support.html" ] && grep -q 'within 24 hours' "$dir/support.html"; then bad="$bad support:says-'within 24 hours'"; fi
  [ -z "$bad" ] || { echo "ponderance.dev registry/support entries (T29 §A):$bad" && return 1; }
  echo "ponderance.dev /privacy, /terms, /support/holdfast name Holdfast; the support page does not promise 24 hours"
}

eval_meta() { # <body of /__meta> <sha>
  local file="$1" want="$2" project commit
  project="$(jq -r '.project // ""' "$file" 2>/dev/null)" || project=""
  commit="$(jq -r '.commit // ""' "$file" 2>/dev/null)" || commit=""
  [ "$project" = "holdfast" ] || { echo "/__meta is not a Holdfast build stamp (project='$project')" && return 1; }
  [ "$commit" = "$want" ] || { echo "deployed commit '$commit' != expected '$want'" && return 1; }
  echo "deployed commit == $want"
}

eval_health_config() { # <body of GET /api/health>
  local file="$1" ok config
  ok="$(jq -r '(.ok // "absent") | tostring' "$file" 2>/dev/null)" || ok="unreadable"
  config="$(jq -r 'if has("config") then (.config | tostring) else "absent" end' "$file" 2>/dev/null)" || config="unreadable"
  [ "$ok" = "true" ] && [ "$config" = "true" ] ||
    { echo "health: ok='$ok' config='$config', expected both true" && return 1; }
  echo "health: ok and config are true"
}

eval_secrets() { # <file with `wrangler secret list --format json`>
  local file="$1" have missing="" name
  have="$(json_tail <"$file" | jq -r 'if type == "array" then .[].name else empty end' 2>/dev/null | sort -u)" || have=""
  [ -n "$have" ] || { echo "the secret list is empty or could not be read" && return 1; }
  for name in $REQUIRED_SECRETS; do
    printf '%s\n' "$have" | grep -qx "$name" || missing="$missing $name"
  done
  [ -z "$missing" ] || { echo "missing:$missing" && return 1; }
  echo "all ten names present ($(printf '%s\n' "$have" | wc -l | tr -d ' ') listed)"
}

eval_hyperdrive() { # <file with `wrangler hyperdrive get <id>`>
  local file="$1" disabled
  disabled="$(json_tail <"$file" | jq -r 'if (.caching | type) == "object" then (.caching.disabled | tostring) else "unreadable" end' 2>/dev/null)" || disabled="unreadable"
  [ "$disabled" = "true" ] || { echo "caching.disabled is '$disabled', expected true" && return 1; }
  echo "caching.disabled = true"
}

eval_notification() { # <file with `wrangler r2 bucket notification list <bucket>`> <queue>
  local file="$1" queue="$2" rules
  rules="$(sed 's/\x1b\[[0-9;]*m//g' "$file" | awk -v want_actions="$OBJECT_CREATE_ACTIONS" '
    function flush() {
      if (seen) {
        n = split(event, parts, ","); asorted = ""
        for (i = 1; i <= n; i++) { gsub(/ /, "", parts[i]); list[i] = parts[i] }
        for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (list[j] < list[i]) { t = list[i]; list[i] = list[j]; list[j] = t }
        for (i = 1; i <= n; i++) asorted = asorted (i > 1 ? "," : "") list[i]
        print queue_name "\t" prefix "\t" suffix "\t" asorted "\t" rule_id "\t" created
      }
      seen = 0; queue_name = prefix = suffix = event = rule_id = created = ""
    }
    /^[[:space:]]*$/ { flush(); next }
    match($0, /^[[:space:]]*[a-z_]+:/) {
      key = substr($0, RSTART, RLENGTH); gsub(/[[:space:]:]/, "", key)
      value = substr($0, RSTART + RLENGTH); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (key == "rule_id") { seen = 1; rule_id = value }
      else if (key == "queue_name") queue_name = value
      else if (key == "prefix") prefix = value
      else if (key == "suffix") suffix = value
      else if (key == "event_type") event = value
      else if (key == "created_at") created = value
    }
    END { flush() }')"
  local count matching
  count="$(printf '%s' "$rules" | grep -c . || true)"
  [ "$count" != "0" ] || { echo "no notification rule listed (nothing to compare)" && return 1; }
  matching="$(printf '%s\n' "$rules" | awk -F'\t' -v q="$queue" -v a="$OBJECT_CREATE_ACTIONS" '$1 == q && $2 == "u/" && $3 == "(all suffixes)" && $4 == a' | grep -c . || true)"
  if [ "$count" != "1" ] || [ "$matching" != "1" ]; then
    echo "$count rule(s) listed, $matching of them object-create on prefix u/ to $queue; expected exactly one such rule and no other"
    printf '%s\n' "$rules" | awk -F'\t' '{ print "   | queue=" $1 " prefix=" $2 " suffix=" $3 " events=" $4 }'
    return 1
  fi
  echo "one rule: object-create ($OBJECT_CREATE_ACTIONS), prefix u/, queue $queue (rule $(printf '%s' "$rules" | cut -f5), created $(printf '%s' "$rules" | cut -f6)) — the listing shows it EXISTS; that it fires is the probe's evidence"
}

eval_probe() { # <gate-b-report.md> — T30 step 7's evidence lines
  local file="$1" key secs control
  [ -s "$file" ] || { echo "$(basename "$file") missing or empty (the probe's evidence goes there, T30 step 7)" && return 1; }
  key="$(grep -oE 'probe key: u/_probe/gate-b-[0-9]{8}T[0-9]{6}Z' "$file" | head -n 1)"
  secs="$(grep -oE 'probe first invocation: [0-9]+(\.[0-9]+)? s' "$file" | head -n 1)"
  control="$(grep -oE 'probe control invocations: [0-9]+' "$file" | head -n 1 | awk '{ print $4 }')"
  [ -n "$key" ] && [ -n "$secs" ] && [ "$control" = "0" ] ||
    { echo "the R2-rule probe's evidence is incomplete in gate-b-report.md: key='${key:-}', first invocation='${secs:-}', control invocations='${control:-absent}' (expected 0)" && return 1; }
  echo "probe evidence: ${key#probe key: }; ${secs#probe }; control invocations 0"
}

eval_headers() { # <snapshot.json> <captured dir> <app origin> <files origin>
  local snapshot="$1" dir="$2" app="$3" files="$4"
  SNAPSHOT="$snapshot" DIR="$dir" APP="$app" FILES="$files" EDGE="$EDGE_HEADERS" NORMALISE="$root/scripts/security/normalise-headers.mjs" \
    node --input-type=module - <<'NODE'
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { normaliseHeaders } = await import(pathToFileURL(process.env.NORMALISE).href);
const snapshot = JSON.parse(readFileSync(process.env.SNAPSHOT, "utf8"));
const edge = new Set(process.env.EDGE.split(/\s+/).filter(Boolean));
// The captured responses: <dir>/<slug>.headers (curl -D) for each compared request.
const plan = [
  ["app host, https (a deploy)", "GET /", "app-root"],
  ["app host, https (a deploy)", "GET /api/health", "app-health"],
  ["app host, https (a deploy)", "GET /s/x", "app-share"],
  ["files host, https (a deploy)", "GET / (404)", "files-root"],
  ["files host, https (a deploy)", "GET /d/… refused (403)", "files-d"],
];
function parse(file) {
  const blocks = readFileSync(file, "utf8").split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b));
  const last = blocks.at(-1);
  if (!last) return null;
  const [statusLine, ...lines] = last.split(/\r?\n/);
  const headers = new Headers();
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return { status: Number(statusLine.split(" ")[1]), headers };
}
const problems = [];
let compared = 0;
for (const [host, label, slug] of plan) {
  const want = snapshot[host]?.[label];
  const file = `${process.env.DIR}/${slug}.headers`;
  if (!want) { problems.push(`${label}: not in the snapshot`); continue; }
  if (!existsSync(file)) { problems.push(`${host} ${label}: no response captured`); continue; }
  const got = parse(file);
  if (!got) { problems.push(`${host} ${label}: no HTTP response captured`); continue; }
  // The deploy's Sentry origin is whatever its CSP names on ingest.*sentry — tokenised like the snapshot's.
  const csp = got.headers.get("content-security-policy") ?? "";
  const sentry = csp.match(/https:\/\/[a-z0-9.-]*ingest[a-z0-9.-]*sentry\.io/)?.[0] ?? null;
  const norm = normaliseHeaders(got.headers, { appOrigin: process.env.APP, filesOrigin: process.env.FILES, sentryOrigin: sentry });
  compared++;
  if (got.status !== want.status) problems.push(`${host} ${label}: status ${got.status}, snapshot ${want.status}`);
  for (const [name, value] of Object.entries(want.headers)) {
    if (!(name in norm)) problems.push(`${host} ${label}: ${name} missing`);
    else if (norm[name] !== value) problems.push(`${host} ${label}: ${name} differs\n     deploy:   ${norm[name]}\n     snapshot: ${value}`);
  }
  for (const name of Object.keys(norm)) {
    if (!(name in want.headers) && !edge.has(name)) problems.push(`${host} ${label}: extra header ${name} (not in the snapshot, not an edge header)`);
  }
  if (got.headers.has("set-cookie")) problems.push(`${host} ${label}: sets a cookie`);
}
if (compared === 0) problems.push("no response compared");
if (problems.length) {
  console.log(`${problems.length} difference(s) from ${process.env.SNAPSHOT.split("/").slice(-1)[0]} after normaliseHeaders:`);
  for (const p of problems) console.log(`   | ${p}`);
  process.exit(1);
}
console.log(`${compared} responses equal the snapshot after normaliseHeaders (edge-only extras allowed: ${[...edge].join(", ")})`);
NODE
}

eval_playwright() { # <playwright json report> <exit status of the run>
  local file="$1" rc="$2" expected unexpected skipped flaky
  expected="$(jq -r '.stats.expected // "x"' "$file" 2>/dev/null)" || expected="x"
  unexpected="$(jq -r '.stats.unexpected // "x"' "$file" 2>/dev/null)" || unexpected="x"
  skipped="$(jq -r '.stats.skipped // "x"' "$file" 2>/dev/null)" || skipped="x"
  flaky="$(jq -r '.stats.flaky // "x"' "$file" 2>/dev/null)" || flaky="x"
  [[ "$expected" =~ ^[0-9]+$ && "$unexpected" =~ ^[0-9]+$ && "$skipped" =~ ^[0-9]+$ && "$flaky" =~ ^[0-9]+$ ]] ||
    { echo "@prod-safe: the run's report could not be read (exit $rc)" && return 1; }
  [ "$expected" -ge 1 ] || { echo "@prod-safe: 0 tests passed (nothing compared)" && return 1; }
  if [ "$unexpected" != "0" ] || [ "$skipped" != "0" ] || [ "$flaky" != "0" ] || [ "$rc" != "0" ]; then
    echo "@prod-safe: $expected passed, $unexpected failed, $skipped skipped, $flaky flaky (exit $rc) — any failure or skip fails the gate"
    jq -r '[.. | objects | select(has("title") and has("tests")) | {title, tests}] | .[] | .title as $t | .tests[] | select(.status != "expected") | "   | \(.projectName // "?"): \($t) → \(.status)"' "$file" 2>/dev/null | sort -u | head -n 20
    return 1
  fi
  echo "@prod-safe: $expected passed, 0 failed, 0 skipped"
}

eval_manifest() { # <_manifest.json> <drizzle snapshot.json> <date>
  local file="$1" schema="$2" date="$3" want have missing
  want="$(jq -r '.tables | to_entries[] | .value.name' "$schema" 2>/dev/null | sort -u)" || want=""
  [ -n "$want" ] || { echo "the schema's table list could not be read from $(basename "$schema")" && return 1; }
  have="$(json_tail <"$file" | jq -r 'if (.tables | type) == "array" then .tables[].name else empty end' 2>/dev/null | sort -u)" || have=""
  [ -n "$have" ] || { echo "no readable manifest for $date (b/db/$date/_manifest.json)" && return 1; }
  missing="$(comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$have") | tr '\n' ' ')"
  [ -z "${missing// /}" ] || { echo "manifest $date lacks table(s): $missing" && return 1; }
  echo "manifest $date lists all $(printf '%s\n' "$want" | wc -l | tr -d ' ') tables of the schema"
}

eval_run() { # <gh run list json> <sha>
  local file="$1" sha="$2" row status conclusion
  row="$(jq -c --arg sha "$sha" 'if type == "array" then [.[] | select(.headSha == $sha)] | first // empty else empty end' "$file" 2>/dev/null)" || row=""
  [ -n "$row" ] || { echo "no workflow run found for commit $sha" && return 1; }
  status="$(printf '%s' "$row" | jq -r '.status // ""')"
  conclusion="$(printf '%s' "$row" | jq -r '.conclusion // ""')"
  [ "$status" = "completed" ] && [ "$conclusion" = "success" ] ||
    { echo "the latest run for $sha is status='$status' conclusion='$conclusion', expected completed/success" && return 1; }
  echo "run $(printf '%s' "$row" | jq -r '.databaseId // "?"') for $sha concluded success"
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────────
self_test() {
  local tmp failures=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-gate-b-selftest.XXXXXX")"
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
  # Every fixture below is made up: the structure of the plan's files, none of their text.

  echo "DMCA agent file:"
  printf 'export const SENTINEL = "TODO" + "_";\nexport const AGENT = {\n  name: "A. Person",\n  email: "agent@example.test",\n};\n' >"$tmp/agent-ok.ts"
  printf 'export const AGENT = {\n  name: "TODO_AGENT_NAME",\n  email: "agent@example.test",\n};\n' >"$tmp/agent-todo.ts"
  printf 'export const SOMETHING = 1;\n' >"$tmp/agent-none.ts"
  expect pass "every field filled" eval_agent "$tmp/agent-ok.ts"
  expect fail "a field still a sentinel" eval_agent "$tmp/agent-todo.ts"
  expect fail "no AGENT block (nothing compared)" eval_agent "$tmp/agent-none.ts"
  expect fail "file missing" eval_agent "$tmp/agent-absent.ts"

  echo "DMCA agent registration line:"
  printf '| 2 | agent | HUMAN | DONE | registered 2026-11-02, renewal 2029-11-02 | |\n' >"$tmp/legal-reg.md"
  printf '| 2 | agent | HUMAN | NOT DONE | Write here: "registered YYYY-MM-DD, renewal YYYY-MM-DD". |\n' >"$tmp/legal-template.md"
  printf 'registered 2026-11-02, renewal 2026-11-01\n' >"$tmp/legal-backwards.md"
  printf 'registered 2026-13-02, renewal 2029-11-02\n' >"$tmp/legal-baddate.md"
  expect pass "registered with a later renewal" eval_dmca_registered "$tmp/legal-reg.md"
  expect fail "only the template's placeholder" eval_dmca_registered "$tmp/legal-template.md"
  expect fail "renewal before registration" eval_dmca_registered "$tmp/legal-backwards.md"
  expect fail "month 13" eval_dmca_registered "$tmp/legal-baddate.md"
  expect fail "file missing" eval_dmca_registered "$tmp/absent.md"

  echo "NCMEC request line:"
  printf 'NCMEC ESP requested 2026-11-03\n' >"$tmp/ncmec-ok.md"
  printf 'Write here: "NCMEC ESP requested YYYY-MM-DD".\n' >"$tmp/ncmec-template.md"
  expect pass "requested on a past date" eval_ncmec "$tmp/ncmec-ok.md" "2026-11-04"
  expect pass "requested today" eval_ncmec "$tmp/ncmec-ok.md" "2026-11-03"
  expect fail "requested in the future" eval_ncmec "$tmp/ncmec-ok.md" "2026-11-02"
  expect fail "only the template's placeholder" eval_ncmec "$tmp/ncmec-template.md" "2026-11-04"

  echo "residual risks:"
  {
    printf '| # | Risk | Source | Date | Initials |\n|---|---|---|---|---|\n'
    printf '| 1 | A made-up risk. | X | 2026-11-02 | AB |\n| 2 | Another. | Y | 2026-11-02 | AB |\n'
    printf '\nCompleted by: A. Person  on: 2026-11-02 (date). Later text.\n'
  } >"$tmp/rr-ok.md"
  sed 's/| 2 | Another. | Y | 2026-11-02 | AB |/| 2 | Another. | Y | ____ | ____ |/' "$tmp/rr-ok.md" >"$tmp/rr-row.md"
  sed 's/^Completed by: .*/Completed by: ____________ (name)  on: ____ (date)./' "$tmp/rr-ok.md" >"$tmp/rr-line.md"
  grep -v '^Completed by' "$tmp/rr-ok.md" >"$tmp/rr-noline.md"
  printf 'This draft is unsigned and not signed; it was designed to be signed.\n' >"$tmp/rr-words.md"
  sed 's/| 1 | A made-up risk. | X | 2026-11-02 | AB |/| 1 | A made-up risk. | X | 2026-11-02 | ____ |/' "$tmp/rr-ok.md" >"$tmp/rr-noinitials.md"
  expect pass "every row and the completion line" eval_residual "$tmp/rr-ok.md"
  expect fail "one row blank" eval_residual "$tmp/rr-row.md"
  expect fail "one row dated, not initialled" eval_residual "$tmp/rr-noinitials.md"
  expect fail "completion line still blank" eval_residual "$tmp/rr-line.md"
  expect fail "no completion line" eval_residual "$tmp/rr-noline.md"
  expect fail "the word 'signed' without any row (the old grep passed this)" eval_residual "$tmp/rr-words.md"

  echo "procedure adoption:"
  printf '# A procedure (v1)\n\nAdopted: 2026-11-02 AB\n\nText.\n' >"$tmp/proc-ok.md"
  printf '# A procedure (DRAFT, not adopted)\n\nAdopted: 2026-11-02 AB\n' >"$tmp/proc-stale.md"
  printf '# A procedure (DRAFT, not adopted)\n\nAdoption: the operator reads, dates and initials this file.\n' >"$tmp/proc-draft.md"
  printf 'Adopted: YYYY-MM-DD <initials>\n' >"$tmp/proc-template.md"
  expect pass "adopted, header updated" eval_adopted "$tmp/proc-ok.md"
  expect fail "adopted line, header still says not adopted" eval_adopted "$tmp/proc-stale.md"
  expect fail "a draft" eval_adopted "$tmp/proc-draft.md"
  expect fail "the format's placeholder" eval_adopted "$tmp/proc-template.md"

  echo "legal files:"
  mkdir -p "$tmp/plan-ok/legal" "$tmp/plan-short/legal"
  for f in csam-procedure dmca-procedure residual-risks gate-b-legal; do echo x >"$tmp/plan-ok/legal/$f.md"; done
  echo x >"$tmp/plan-short/legal/gate-b-legal.md"
  : >"$tmp/plan-short/legal/residual-risks.md"
  expect pass "all four" eval_legal_files "$tmp/plan-ok"
  expect fail "two missing, one empty" eval_legal_files "$tmp/plan-short"
  expect fail "no plan directory" eval_legal_files "$tmp/plan-absent"

  echo "ponderance.dev pages:"
  mkdir -p "$tmp/pd-ok" "$tmp/pd-none" "$tmp/pd-24" "$tmp/pd-down"
  for p in privacy terms support; do echo "<p>Holdfast</p>" >"$tmp/pd-ok/$p.html"; echo "<p>Other</p>" >"$tmp/pd-none/$p.html"; echo "<p>Holdfast</p>" >"$tmp/pd-24/$p.html"; done
  echo "<p>Holdfast answers within 24 hours</p>" >"$tmp/pd-24/support.html"
  echo "<p>Holdfast</p>" >"$tmp/pd-down/privacy.html"
  expect pass "all three name Holdfast" eval_ponderance "$tmp/pd-ok"
  expect fail "no Holdfast entries" eval_ponderance "$tmp/pd-none"
  expect fail "support promises 24 hours" eval_ponderance "$tmp/pd-24"
  expect fail "two pages unreachable" eval_ponderance "$tmp/pd-down"

  echo "build stamp and health:"
  echo "{\"project\":\"holdfast\",\"commit\":\"$sha\"}" >"$tmp/meta-ok.json"
  echo "{\"project\":\"holdfast\",\"commit\":\"$other\"}" >"$tmp/meta-other.json"
  echo '<html>Not found</html>' >"$tmp/meta-junk.json"
  : >"$tmp/meta-empty.json"
  expect pass "stamp equals the branch head" eval_meta "$tmp/meta-ok.json" "$sha"
  expect fail "another commit deployed" eval_meta "$tmp/meta-other.json" "$sha"
  expect fail "not a stamp" eval_meta "$tmp/meta-junk.json" "$sha"
  expect fail "empty answer" eval_meta "$tmp/meta-empty.json" "$sha"
  echo '{"ok":true,"db":true,"config":true}' >"$tmp/health-ok.json"
  echo '{"ok":true,"config":false}' >"$tmp/health-bad.json"
  echo '{"ok":false,"config":true}' >"$tmp/health-down.json"
  expect pass "ok and config" eval_health_config "$tmp/health-ok.json"
  expect fail "config false" eval_health_config "$tmp/health-bad.json"
  expect fail "ok false" eval_health_config "$tmp/health-down.json"
  expect fail "empty answer" eval_health_config "$tmp/meta-empty.json"

  echo "secrets (ten names):"
  local names
  names="$(printf '"%s",' $REQUIRED_SECRETS)"
  printf ' ⛅️ wrangler\n%s\n' "$(echo "[${names%,}]" | jq -c '[.[] | {name: ., type: "secret_text"}]')" >"$tmp/sec-ok.txt"
  echo "[${names%,}]" | jq -c '[.[] | select(. != "CF_ANALYTICS_TOKEN") | {name: ., type: "secret_text"}]' >"$tmp/sec-nine.txt"
  echo '[]' >"$tmp/sec-empty.txt"
  echo 'Authentication error [code: 10000]' >"$tmp/sec-error.txt"
  expect pass "all ten (after wrangler's banner)" eval_secrets "$tmp/sec-ok.txt"
  expect fail "CF_ANALYTICS_TOKEN missing" eval_secrets "$tmp/sec-nine.txt"
  expect fail "empty list" eval_secrets "$tmp/sec-empty.txt"
  expect fail "an error instead" eval_secrets "$tmp/sec-error.txt"

  echo "hyperdrive:"
  printf ' ⛅️ wrangler\n{\n  "id": "x",\n  "caching": { "disabled": true }\n}\n' >"$tmp/hd-off.txt"
  echo '{"id":"x","caching":{"disabled":false,"max_age":60}}' >"$tmp/hd-on.txt"
  echo '{"id":"x","caching":{}}' >"$tmp/hd-default.txt"
  echo 'Authentication error' >"$tmp/hd-error.txt"
  expect pass "caching disabled" eval_hyperdrive "$tmp/hd-off.txt"
  expect fail "caching enabled" eval_hyperdrive "$tmp/hd-on.txt"
  expect fail "caching block without disabled (default on)" eval_hyperdrive "$tmp/hd-default.txt"
  expect fail "an error instead" eval_hyperdrive "$tmp/hd-error.txt"

  echo "R2 notification rule:"
  rule() { # <queue> <prefix> <events>
    printf 'rule_id:    r-%s\ncreated_at: 2026-10-01T00:00:00Z\nqueue_name: %s\nprefix:     %s\nsuffix:     (all suffixes)\nevent_type: %s\n' "$RANDOM" "$1" "$2" "$3"
  }
  { echo "Fetching notification rules for bucket b..."; rule q-scan u/ "PutObject,CompleteMultipartUpload,CopyObject"; } >"$tmp/nr-ok.txt"
  { rule q-scan u/ "PutObject,CompleteMultipartUpload,CopyObject"; echo; rule q-scan b/ "PutObject"; } >"$tmp/nr-two.txt"
  rule q-scan "(all prefixes)" "PutObject,CompleteMultipartUpload,CopyObject" >"$tmp/nr-allprefix.txt"
  rule q-other u/ "PutObject,CompleteMultipartUpload,CopyObject" >"$tmp/nr-queue.txt"
  rule q-scan u/ "DeleteObject" >"$tmp/nr-delete.txt"
  echo "Fetching notification rules for bucket b..." >"$tmp/nr-none.txt"
  expect pass "one object-create rule on u/ to the queue" eval_notification "$tmp/nr-ok.txt" q-scan
  expect fail "a second rule" eval_notification "$tmp/nr-two.txt" q-scan
  expect fail "rule on every prefix" eval_notification "$tmp/nr-allprefix.txt" q-scan
  expect fail "rule to another queue" eval_notification "$tmp/nr-queue.txt" q-scan
  expect fail "object-delete rule" eval_notification "$tmp/nr-delete.txt" q-scan
  expect fail "no rule (nothing compared)" eval_notification "$tmp/nr-none.txt" q-scan

  echo "R2-rule probe evidence (--prod):"
  printf 'probe key: u/_probe/gate-b-20261102T101500Z\nprobe first invocation: 4.2 s\nprobe control invocations: 0\n' >"$tmp/probe-ok.md"
  printf 'probe key: u/_probe/gate-b-20261102T101500Z\nprobe first invocation: 4 s\nprobe control invocations: 2\n' >"$tmp/probe-control.md"
  printf 'probe key: u/_probe/gate-b-20261102T101500Z\n' >"$tmp/probe-partial.md"
  expect pass "key, delay and a silent control" eval_probe "$tmp/probe-ok.md"
  expect fail "the control fired" eval_probe "$tmp/probe-control.md"
  expect fail "only the key" eval_probe "$tmp/probe-partial.md"
  expect fail "no report" eval_probe "$tmp/absent.md"

  echo "headers against the snapshot:"
  local app="https://app.example.test" files="https://files.example.test" snap="$root/$HEADER_SNAPSHOT"
  if [ -f "$snap" ]; then
    mkdir -p "$tmp/h-ok" "$tmp/h-extra" "$tmp/h-differs" "$tmp/h-none"
    SNAP="$snap" APP="$app" FILES="$files" OUT="$tmp/h-ok" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.SNAP, "utf8"));
const map = { "app-root": ["app host, https (a deploy)", "GET /"], "app-health": ["app host, https (a deploy)", "GET /api/health"],
  "app-share": ["app host, https (a deploy)", "GET /s/x"], "files-root": ["files host, https (a deploy)", "GET / (404)"],
  "files-d": ["files host, https (a deploy)", "GET /d/… refused (403)"] };
const nonce = "Ab3dE5gH7jK9mN1pQ2rS4t==";
for (const [slug, [host, label]] of Object.entries(map)) {
  const want = s[host][label];
  const lines = [`HTTP/2 ${want.status}`, "date: Mon, 02 Nov 2026 10:00:00 GMT", "server: cloudflare", "cf-ray: 1-ABC"];
  for (const [n, v] of Object.entries(want.headers)) {
    lines.push(`${n}: ${v.replaceAll("<NONCE>", nonce).replaceAll("<FILES_ORIGIN>", process.env.FILES).replaceAll("<APP_ORIGIN>", process.env.APP).replaceAll("<SENTRY_ORIGIN>", "https://o1.ingest.us.sentry.io").replaceAll("<validator>", '"v1"')}`);
  }
  writeFileSync(`${process.env.OUT}/${slug}.headers`, lines.join("\r\n") + "\r\n\r\n");
}
NODE
    cp "$tmp/h-ok/"*.headers "$tmp/h-extra/" && cp "$tmp/h-ok/"*.headers "$tmp/h-differs/"
    perl -pi -e 's/^server: cloudflare\r$/server: cloudflare\r\nx-powered-by: something\r/' "$tmp/h-extra/app-root.headers"
    perl -pi -e 's/^x-frame-options: DENY/x-frame-options: SAMEORIGIN/' "$tmp/h-differs/app-root.headers"
    expect pass "the snapshot, as a deploy would send it (nonce, origins, edge headers)" eval_headers "$snap" "$tmp/h-ok" "$app" "$files"
    expect fail "an extra header" eval_headers "$snap" "$tmp/h-extra" "$app" "$files"
    expect fail "a header with another value" eval_headers "$snap" "$tmp/h-differs" "$app" "$files"
    expect fail "nothing captured" eval_headers "$snap" "$tmp/h-none" "$app" "$files"
  else
    echo "  WRONG the header snapshot $HEADER_SNAPSHOT is missing"
    failures=$((failures + 1))
  fi

  echo "@prod-safe run report:"
  echo '{"stats":{"expected":8,"unexpected":0,"skipped":0,"flaky":0}}' >"$tmp/pw-ok.json"
  echo '{"stats":{"expected":7,"unexpected":0,"skipped":1,"flaky":0}}' >"$tmp/pw-skip.json"
  echo '{"stats":{"expected":7,"unexpected":1,"skipped":0,"flaky":0}}' >"$tmp/pw-fail.json"
  echo '{"stats":{"expected":0,"unexpected":0,"skipped":0,"flaky":0}}' >"$tmp/pw-zero.json"
  echo 'Error: No tests found' >"$tmp/pw-junk.json"
  expect pass "8 passed" eval_playwright "$tmp/pw-ok.json" 0
  expect fail "one skipped" eval_playwright "$tmp/pw-skip.json" 0
  expect fail "one failed" eval_playwright "$tmp/pw-fail.json" 1
  expect fail "0 tests" eval_playwright "$tmp/pw-zero.json" 0
  expect fail "green stats, non-zero exit (the skip reporter refused)" eval_playwright "$tmp/pw-ok.json" 1
  expect fail "not a report" eval_playwright "$tmp/pw-junk.json" 1

  echo "backup manifest:"
  echo '{"tables":{"public.a":{"name":"a"},"public.b":{"name":"b"}}}' >"$tmp/schema.json"
  echo '{"date":"2026-11-02","tables":[{"name":"a","rows":1},{"name":"b","rows":0}]}' >"$tmp/man-ok.json"
  echo '{"date":"2026-11-02","tables":[{"name":"a","rows":1}]}' >"$tmp/man-short.json"
  echo '<Error><Code>NoSuchKey</Code></Error>' >"$tmp/man-none.json"
  expect pass "every table listed" eval_manifest "$tmp/man-ok.json" "$tmp/schema.json" 2026-11-02
  expect fail "a table missing" eval_manifest "$tmp/man-short.json" "$tmp/schema.json" 2026-11-02
  expect fail "no manifest" eval_manifest "$tmp/man-none.json" "$tmp/schema.json" 2026-11-02
  expect fail "schema unreadable" eval_manifest "$tmp/man-ok.json" "$tmp/absent.json" 2026-11-02

  echo "deploy workflow run:"
  echo "[{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"success\",\"databaseId\":7}]" >"$tmp/run-ok.json"
  echo "[{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"failure\",\"databaseId\":9},{\"headSha\":\"$sha\",\"status\":\"completed\",\"conclusion\":\"success\",\"databaseId\":7}]" >"$tmp/run-rerun-failed.json"
  echo "[{\"headSha\":\"$other\",\"status\":\"completed\",\"conclusion\":\"success\",\"databaseId\":7}]" >"$tmp/run-other.json"
  echo "[]" >"$tmp/run-none.json"
  expect pass "success for this commit" eval_run "$tmp/run-ok.json" "$sha"
  expect fail "newest run for the commit failed" eval_run "$tmp/run-rerun-failed.json" "$sha"
  expect fail "green run for another commit" eval_run "$tmp/run-other.json" "$sha"
  expect fail "no runs" eval_run "$tmp/run-none.json" "$sha"

  echo "the gate's own bookkeeping:"
  expect fail "a mode that ran fewer checks than it expects" bookkeeping_verdict 3 0 4
  expect fail "every check ran, one failed" bookkeeping_verdict 4 1 4
  expect pass "every check ran and passed" bookkeeping_verdict 4 0 4

  if [ "$failures" -gt 0 ]; then
    echo "verify-gate-b --self-test: $failures evaluator(s) gave the wrong verdict" >&2
    exit 1
  fi
  echo "verify-gate-b --self-test: OK"
}

# ── the gate: every check runs; a summary at the end ─────────────────────────────────────────────
ran=0
failed_ids=""

check() { # <id> <owner> <command...> — runs it, prints PASS/FAIL with its reason, never stops the gate
  local id="$1" owner="$2" out rc
  shift 2
  out="$("$@" 2>&1)" && rc=0 || rc=$?
  ran=$((ran + 1))
  local first rest
  first="$(printf '%s\n' "$out" | head -n 1)"
  rest="$(printf '%s\n' "$out" | tail -n +2)"
  if [ "$rc" = "0" ]; then
    printf 'PASS  %-20s [%s] %s\n' "$id" "$owner" "$first"
  else
    printf 'FAIL  %-20s [%s] %s\n' "$id" "$owner" "${first:-no output (the check could not run)}"
    failed_ids="$failed_ids $id"
  fi
  [ -z "$rest" ] || printf '%s\n' "$rest" | sed 's/^/      /'
}

bookkeeping_verdict() { # <ran> <failed count> <expected>
  [ "$1" = "$3" ] && [ "$2" = "0" ]
}

resolve_plan() {
  if [ -n "$plan_dir" ]; then return 0; fi
  local common
  common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  plan_dir="$(dirname "${common:-$root/.git}")/holdfast-plan"
}

local_checks() {
  check legal-files "HUMAN/T29" eval_legal_files "$plan_dir"
  check dmca-agent-page "HUMAN/T29 §B" eval_agent "$root/$AGENT_FILE"
  check dmca-registered "HUMAN/T29 §B.1" eval_dmca_registered "$plan_dir/legal/gate-b-legal.md"
  check dmca-procedure "HUMAN/T29 §B.3" eval_adopted "$plan_dir/legal/dmca-procedure.md"
  check csam-procedure "HUMAN/T29 §C.1" eval_adopted "$plan_dir/legal/csam-procedure.md"
  check ncmec-requested "HUMAN/T29 §C.2" eval_ncmec "$plan_dir/legal/gate-b-legal.md" "$(date -u +%Y-%m-%d)"
  check residual-risks "HUMAN/T29 §F" eval_residual "$plan_dir/legal/residual-risks.md"
}
LOCAL_CHECKS=7

# ── remote checks (read-only) ──
check_ponderance() {
  local d="$tmpdir/ponderance" p
  mkdir -p "$d"
  for p in privacy terms; do curl -fsS --max-time 20 "$PONDERANCE/$p" >"$d/$p.html" 2>/dev/null || : >"$d/$p.html"; done
  curl -fsS --max-time 20 "$PONDERANCE/support/holdfast" >"$d/support.html" 2>/dev/null || : >"$d/support.html"
  eval_ponderance "$d"
}

check_stamp() {
  git -C "$root" fetch --quiet origin "$branch" 2>/dev/null || { echo "could not fetch origin/$branch" && return 1; }
  branch_sha="$(git -C "$root" rev-parse "origin/$branch")"
  curl -sS --max-time 15 -H 'cache-control: no-cache' "$app_url/__meta" >"$tmpdir/meta.json" 2>/dev/null || : >"$tmpdir/meta.json"
  eval_meta "$tmpdir/meta.json" "$branch_sha" | sed "s|^|$app_url/__meta: |; s|expected '|origin/$branch '|"
  return "${PIPESTATUS[0]}"
}

check_health() {
  curl -sS --max-time 15 "$app_url/api/health" >"$tmpdir/health.json" 2>/dev/null || : >"$tmpdir/health.json"
  eval_health_config "$tmpdir/health.json"
}

check_files_host() {
  local out rc=0
  out="$(bash "$lib" files-host "$files_url/" 2>&1)" || rc=$?
  if [ "$rc" = "0" ]; then echo "$files_url/ → 404 text/plain, no cookie (deploy-lib files-host)"; else
    echo "deploy-lib files-host refused $files_url/:"
    printf '%s\n' "$out" | grep -v -E 'postgres(ql)?://' | tail -n 8
  fi
  return "$rc"
}

check_secrets() {
  (cd "$root" && npx wrangler secret list --name "$worker" --format json) >"$tmpdir/secrets.json" 2>/dev/null || : >"$tmpdir/secrets.json"
  eval_secrets "$tmpdir/secrets.json" | sed "s|^|$worker: |"
  return "${PIPESTATUS[0]}"
}

check_hyperdrive() {
  local id
  id="$(node -e '
    // JSONC: comments removed outside strings (a URL keeps its "//"), then trailing commas.
    const src = require("fs").readFileSync(process.argv[1], "utf8");
    let out = "", inString = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inString) {
        out += c;
        if (c === "\\") out += src[++i];
        else if (c === "\"") inString = false;
      } else if (c === "\"") { inString = true; out += c; }
      else if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; }
      else if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; }
      else out += c;
    }
    const cfg = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    const block = process.argv[2] === "production" ? cfg.env.production : cfg;
    process.stdout.write(String(block.hyperdrive?.[0]?.id ?? ""));' "$root/wrangler.jsonc" "$env_name" 2>/dev/null)" || id=""
  [ -n "$id" ] || { echo "no Hyperdrive id for $env_name in wrangler.jsonc" && return 1; }
  # `hyperdrive get` prints connection details: kept in a file, only `.caching` is read.
  (cd "$root" && npx wrangler hyperdrive get "$id") >"$tmpdir/hyperdrive.txt" 2>/dev/null || : >"$tmpdir/hyperdrive.txt"
  eval_hyperdrive "$tmpdir/hyperdrive.txt" | sed "s|^|$env_name config $id: |"
  return "${PIPESTATUS[0]}"
}

check_notification() {
  (cd "$root" && npx wrangler r2 bucket notification list "$bucket") >"$tmpdir/notification.txt" 2>/dev/null || : >"$tmpdir/notification.txt"
  eval_notification "$tmpdir/notification.txt" "$queue" | sed "1s|^|$bucket: |"
  return "${PIPESTATUS[0]}"
}

check_probe() { eval_probe "$plan_dir/gate-b-report.md"; }

check_headers() {
  local d="$tmpdir/headers" slug url
  mkdir -p "$d"
  for slug in app-root:"$app_url/" app-health:"$app_url/api/health" app-share:"$app_url/s/x" files-root:"$files_url/" files-d:"$files_url/d/abc/def"; do
    url="${slug#*:}"
    curl -sS --max-time 15 -D "$d/${slug%%:*}.headers" -o /dev/null "$url" 2>/dev/null || rm -f "$d/${slug%%:*}.headers"
  done
  eval_headers "$root/$HEADER_SNAPSHOT" "$d" "$app_url" "$files_url"
}

check_prod_safe() {
  local rc=0
  [ -f "$root/$DMCA_SPEC" ] || { echo "$DMCA_SPEC missing" && return 1; }
  (cd "$root" && HOLDFAST_E2E_BASE_URL="$app_url" HOLDFAST_E2E_FAIL_ON_SKIP=1 PLAYWRIGHT_JSON_OUTPUT_FILE="$tmpdir/pw.json" \
    npx playwright test --grep @prod-safe --reporter="list,json,./tests/e2e/fixtures/skip-reporter.ts") >"$tmpdir/pw.log" 2>&1 || rc=$?
  eval_playwright "$tmpdir/pw.json" "$rc" || { grep -E 'skip|SKIP' "$tmpdir/pw.log" | grep -v '^\s*$' | head -n 8 | sed 's/^/   | /'; return 1; }
}

check_backup() {
  local schema day d found=""
  schema="$(ls "$root"/drizzle/meta/*_snapshot.json 2>/dev/null | sort | tail -n 1)"
  [ -n "$schema" ] || { echo "no drizzle snapshot to read the table list from" && return 1; }
  # Today's set, or — before today's 02:00 UTC run has written it — yesterday's.
  for day in "$(date -u +%Y-%m-%d)" "$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d yesterday +%Y-%m-%d)"; do
    d="$tmpdir/manifest-$day.json"
    (cd "$root" && npx wrangler r2 object get "$bucket/b/db/$day/_manifest.json" --remote --pipe) >"$d" 2>/dev/null || : >"$d"
    if json_tail <"$d" | jq -e '.tables' >/dev/null 2>&1; then found="$day" && break; fi
  done
  [ -n "$found" ] || { echo "no _manifest.json for today or yesterday in $bucket/b/db/ (trigger T25's backup job, or wait for 02:00 UTC)" && return 1; }
  eval_manifest "$tmpdir/manifest-$found.json" "$schema" "$found"
}

check_ci() {
  [ -n "${branch_sha:-}" ] || branch_sha="$(git -C "$root" rev-parse "origin/$branch" 2>/dev/null)"
  (cd "$root" && gh run list --workflow "$workflow" --branch "$branch" --limit 40 --json headSha,status,conclusion,databaseId) >"$tmpdir/runs.json" 2>/dev/null ||
    { echo "'gh run list --workflow $workflow' failed" && return 1; }
  eval_run "$tmpdir/runs.json" "$branch_sha" | sed "s|^|$workflow on $branch: |"
  return "${PIPESTATUS[0]}"
}

remote_checks() {
  check ponderance-pages "T29 §A (ponderance)" check_ponderance
  check stamp "deploy" check_stamp
  check health "deploy" check_health
  check files-host "deploy" check_files_host
  check secrets "T30 §5 / T27" check_secrets
  check hyperdrive "infra" check_hyperdrive
  check r2-rule "T30 §7" check_notification
  [ "$env_name" = "production" ] && check r2-probe "T30 §7 evidence" check_probe
  check headers "T26 snapshot" check_headers
  check prod-safe-e2e "T28/T29 §B" check_prod_safe
  check backup-manifest "T27/T25" check_backup
  check ci-run "CI" check_ci
}

gate() {
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/holdfast-gate-b.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'" EXIT
  local tool missing=""
  for tool in git jq curl node npx gh; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
  if [ -n "$missing" ]; then echo "verify-gate-b: missing tools:$missing" >&2 && exit 1; fi

  echo "Gate B against $env_name ($app_url, $files_url); plan directory $plan_dir"
  local expected=$((LOCAL_CHECKS + 11))
  [ "$env_name" = "production" ] && expected=$((expected + 1))
  local_checks
  remote_checks
  local nfail
  nfail="$(printf '%s' "$failed_ids" | wc -w | tr -d ' ')"
  echo "──"
  if bookkeeping_verdict "$ran" "$nfail" "$expected"; then
    echo "GATE B ($env_name): PASS — $ran of $expected checks ran and passed"
    echo "Not automated (evidence in gate-b-report.md): C2 abort test, load test, abuse drill, kill switches, Orrery, the HUMAN dashboard steps."
    exit 0
  fi
  echo "GATE B ($env_name): FAIL — $nfail of $ran checks failed ($expected expected):$failed_ids" >&2
  exit 1
}

mode="gate"
env_name="dev"
plan_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test) mode="self-test" ;;
    --local-only) mode="local" ;;
    --prod) env_name="production" ;;
    --plan)
      [ "$#" -ge 2 ] || { echo "--plan needs a directory" >&2 && exit 2; }
      plan_dir="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "verify-gate-b: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$env_name" = "production" ]; then
  app_url="https://holdfast.ponderance.dev" files_url="https://holdfastusercontent.com" worker="holdfast"
  bucket="holdfast-files" queue="holdfast-scan" branch="prod" workflow="deploy-prod.yml"
else
  app_url="https://holdfast-dev.ponderance.dev" files_url="https://dev.holdfastusercontent.com" worker="holdfast-dev"
  bucket="holdfast-files-dev" queue="holdfast-scan-dev" branch="dev" workflow="deploy-dev.yml"
fi
resolve_plan

case "$mode" in
  self-test) self_test ;;
  local)
    command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2 && exit 1; }
    echo "Gate B local checks (files only; plan directory $plan_dir)"
    local_checks
    nfail="$(printf '%s' "$failed_ids" | wc -w | tr -d ' ')"
    echo "──"
    if [ "$nfail" = "0" ] && [ "$ran" = "$LOCAL_CHECKS" ]; then
      # Deliberately not 0: a run without the remote checks is never a gate result.
      echo "LOCAL CHECKS PASS ($ran of $LOCAL_CHECKS) — this is NOT a Gate B result (no remote check was run)"
      exit 3
    fi
    echo "GATE B local checks: FAIL — $nfail of $ran failed:$failed_ids" >&2
    exit 1
    ;;
  gate) gate ;;
esac
