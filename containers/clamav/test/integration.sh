#!/usr/bin/env bash
# Container integration run (T20 step 7) — the ONLY place containers are enabled. Starts a local
# `wrangler dev` with a throwaway config (containers on, the test-only entry test/entry.mjs that drives
# scanObject / scanSmall / scannerHealth from src/worker/scan/container.ts) and checks, against two
# real scanner containers:
#   EICAR → infected; a clean object → clean with the right sha256; two concurrent large scans land on
#   different instances or the second gets ScannerBusyError.
# Exits non-zero when Docker or containers are unavailable — it never reports green by skipping.
#   containers/clamav/test/integration.sh       (needs containers/clamav/cvd/; on a Mac export
#                                                DOCKER_CONTEXT; listens on $HOLDFAST_PORT, default 8799)
# wrangler 4.148 has no `wrangler dev` flag for containers, hence the config copy.
set -euo pipefail
test_dir="$(cd "$(dirname "$0")" && pwd)"
clamav="$(cd "$test_dir/.." && pwd)"
repo="$(cd "$clamav/../.." && pwd)"
port="${HOLDFAST_PORT:-8799}"
config="$test_dir/wrangler.integration.jsonc" # gitignored
log="$(mktemp)"
work="$(mktemp -d)"
failures=0
wrangler=""

die() { echo "integration: $*" >&2; exit 1; }
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; failures=$((failures + 1)); }

docker info >/dev/null 2>&1 || die "Docker is not available (DOCKER_CONTEXT=${DOCKER_CONTEXT:-unset})"
for f in main.cvd daily.cvd bytecode.cvd; do
  [ -s "$clamav/cvd/$f" ] || die "containers/clamav/cvd/$f is missing — run containers/clamav/fetch-cvd.sh once"
done

cleanup() {
  if [ -n "$wrangler" ]; then
    kill -TERM "$wrangler" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$wrangler" 2>/dev/null || break; sleep 1; done
    kill -KILL "$wrangler" 2>/dev/null || true
  fi
  # What wrangler started for this config: the scanner containers (from the image it built) and their
  # egress proxies (named after this config's Worker).
  for id in $(docker ps -aq 2>/dev/null); do
    if docker inspect -f '{{.Config.Image}} {{.Name}}' "$id" 2>/dev/null |
      grep -qE '^cloudflare-dev/scannercontainer|/workerd-holdfast-scanner-integration-'; then
      docker rm -f "$id" >/dev/null 2>&1 || true
    fi
  done
  rm -f "$config"
  rm -rf "$work"
}
trap cleanup EXIT

cat >"$config" <<EOF
// Throwaway config written by integration.sh — never committed, never deployed.
{
  "name": "holdfast-scanner-integration",
  "main": "entry.mjs",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "dev": { "enable_containers": true },
  "containers": [
    { "class_name": "ScannerContainer", "image": "../Dockerfile", "max_instances": 2, "instance_type": "standard-1" }
  ],
  "durable_objects": { "bindings": [{ "name": "SCANNER", "class_name": "ScannerContainer" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ScannerContainer"] }]
}
EOF

echo "== wrangler dev (containers on) on :$port"
(
  cd "$repo"
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false exec npx wrangler dev \
    --config "$config" --ip 127.0.0.1 --port "$port" --inspector-port $((port + 20000)) \
    --persist-to "$work/state" --show-interactive-dev-session=false
) >"$log" 2>&1 &
wrangler=$!

get() { curl -s --max-time 60 "http://127.0.0.1:$port$1"; }

# Each instance: started by its first /health call, then ready once clamd has loaded.
for name in scanner-0 scanner-1; do
  started=$(date +%s)
  until get "/t/health?name=$name" 2>/dev/null | jq -e '.verdict.ready == true' >/dev/null 2>&1; do
    kill -0 "$wrangler" 2>/dev/null || { tail -40 "$log" >&2; die "wrangler dev exited"; }
    [ $(($(date +%s) - started)) -lt 1200 ] || { tail -40 "$log" >&2; die "$name never became ready"; }
    sleep 3
  done
  echo "$name ready after $(($(date +%s) - started)) s: $(get "/t/health?name=$name" | jq -c .verdict)"
done

# scan <path> <file> [key] → the entry's JSON
scan() {
  curl -s --max-time 900 -X POST -H "X-Object-Size: $(wc -c <"$2" | tr -d ' ')" -T "$2" \
    "http://127.0.0.1:$port$1${3:+?key=$3}" || true # an answer before the upload ends cuts curl's send
}

printf '%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR' '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' >"$work/eicar.com"
head -c 20000000 /dev/urandom >"$work/clean.bin"
eicar_sha="$(shasum -a 256 "$work/eicar.com" | cut -d' ' -f1)"
clean_sha="$(shasum -a 256 "$work/clean.bin" | cut -d' ' -f1)"

echo "== scanSmall: EICAR"
r="$(scan /t/scan-small "$work/eicar.com")"
if jq -e --arg s "$eicar_sha" '.verdict.status == "infected" and (.verdict.signatures | index("Eicar-Test-Signature")) and .verdict.sha256 == $s' <<<"$r" >/dev/null; then
  ok "scanSmall(EICAR) → infected Eicar-Test-Signature $(jq -c .calls <<<"$r")"
else
  bad "scanSmall(EICAR) → $r"
fi

echo "== scanObject: EICAR and a clean 20 MB object"
r="$(scan /t/scan-object "$work/eicar.com" u/it/eicar)"
if jq -e '.verdict.status == "infected"' <<<"$r" >/dev/null; then ok "scanObject(EICAR) → infected $(jq -c .calls <<<"$r")"; else bad "scanObject(EICAR) → $r"; fi
r="$(scan /t/scan-object "$work/clean.bin" u/it/clean)"
if jq -e --arg s "$clean_sha" '.verdict.status == "clean" and .verdict.sha256 == $s and .verdict.bytes == 20000000' <<<"$r" >/dev/null; then
  ok "scanObject(20 MB random) → clean, sha256 = shasum $(jq -c .calls <<<"$r")"
else
  bad "scanObject(clean) → $r"
fi

echo "== two concurrent large scans preferring the same instance"
head -c 300000000 /dev/urandom >"$work/large-a.bin"
head -c 300000000 /dev/urandom >"$work/large-b.bin"
keys="$(get '/t/keys?instance=scanner-0&count=2')"
key_a="$(jq -r '.keys[0]' <<<"$keys")"
key_b="$(jq -r '.keys[1]' <<<"$keys")"
scan /t/scan-object "$work/large-a.bin" "$key_a" >"$work/a.json" &
first=$!
# The second starts once the first holds scanner-0's large-scan slot.
started=$(date +%s)
until get "/t/health?name=scanner-0" | jq -e '.verdict.busy == true' >/dev/null 2>&1; do
  kill -0 "$first" 2>/dev/null || break
  [ $(($(date +%s) - started)) -lt 300 ] || break
  sleep 0.5
done
get "/t/health?name=scanner-0" | jq -c '{busy: .verdict.busy}'
scan /t/scan-object "$work/large-b.bin" "$key_b" >"$work/b.json"
wait "$first"
echo "first:  $(jq -c '{status: .verdict.status, error: .error, calls, pulledBytes}' "$work/a.json")"
echo "second: $(jq -c '{status: .verdict.status, error: .error, calls, pulledBytes}' "$work/b.json")"
a_on="$(jq -r '[.calls[] | select(.status == 200) | .name] | first // ""' "$work/a.json")"
b_on="$(jq -r '[.calls[] | select(.status == 200) | .name] | first // ""' "$work/b.json")"
b_busy_first="$(jq -r '.calls[0].status == 503' "$work/b.json")"
if [ "$(jq -r .verdict.status "$work/a.json")" = clean ] &&
  { { [ "$(jq -r .verdict.status "$work/b.json")" = clean ] && [ -n "$b_on" ] && [ "$a_on" != "$b_on" ] && [ "$b_busy_first" = true ]; } ||
    [ "$(jq -r .error.name "$work/b.json")" = ScannerBusyError ]; }; then
  ok "first on $a_on; second refused busy by scanner-0 and $( [ -n "$b_on" ] && echo "scanned on $b_on" || echo "got ScannerBusyError")"
else
  bad "two large scans on one instance, or another outcome"
fi
for f in a b; do
  want="$(shasum -a 256 "$work/large-$f.bin" | cut -d' ' -f1)"
  got="$(jq -r '.verdict.sha256 // empty' "$work/$f.json")"
  if [ -z "$got" ] || [ "$got" = "$want" ]; then ok "large-$f sha256 ${got:+= shasum}${got:-(no verdict)}"; else bad "large-$f sha256 $got ≠ $want"; fi
done

echo "integration: $failures failure(s)"
[ "$failures" = 0 ]
