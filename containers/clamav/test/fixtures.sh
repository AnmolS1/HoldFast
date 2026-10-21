#!/usr/bin/env bash
# The shim against the real clamd (T20 step 3): builds the image's `test` target, runs it with no
# contact to the signature mirror (SCANNER_OFFLINE=1) and checks every fixture's verdict and that
# the shim's sha256 equals `shasum -a 256` of what was sent. Exits non-zero on any failure, and when
# Docker is unavailable.
#   containers/clamav/test/fixtures.sh        (needs containers/clamav/cvd/; on a Mac export DOCKER_CONTEXT)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image=hf-clamav-test
port="${FIXTURE_PORT:-18621}"
work="$(mktemp -d)"
failures=0
names=()

cleanup() {
  for n in "${names[@]}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT

ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; failures=$((failures + 1)); }

docker info >/dev/null 2>&1 || { echo "fixtures: Docker is not available" >&2; exit 2; }
docker build -q --platform linux/amd64 --target test -t "$image" "$here" >/dev/null

# start <name> [docker run options…]: runs the test image on $port and waits for /health ready.
start() {
  local name="$1"; shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  names+=("$name")
  docker run -d --platform linux/amd64 --name "$name" -e SCANNER_OFFLINE=1 -p "127.0.0.1:$port:8080" "$@" "$image" >/dev/null
  local i
  for i in $(seq 1 120); do
    if curl -sf "localhost:$port/health" 2>/dev/null | grep -q '"ready":true'; then return 0; fi
    sleep 2
  done
  echo "fixtures: $name never became ready" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  exit 1
}
stop() { docker rm -f "$1" >/dev/null; }

# scan <file> → the response body; the HTTP status goes to $work/code.
scan() {
  curl -s -o "$work/body" -w '%{http_code}' -H "X-Scan-Size: $(wc -c <"$1" | tr -d ' ')" --data-binary @"$1" \
    "localhost:$port/scan" >"$work/code"
  cat "$work/body"
}

# expect <file> <status> [signature prefix] [pua prefix]
expect() {
  local file="$1" status="$2" sig="${3:-}" pua="${4:-}" body want got
  body="$(scan "$file")"
  want="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  got="$(jq -r .sha256 <<<"$body")"
  local name; name="$(basename "$file")"
  if [ "$(cat "$work/code")" != 200 ] || [ "$(jq -r .status <<<"$body")" != "$status" ]; then
    bad "$name → $(cat "$work/code") $body (want $status)"; return
  fi
  if [ "$got" != "$want" ] || [ "$(jq -r .bytes <<<"$body")" != "$(wc -c <"$file" | tr -d ' ')" ]; then
    bad "$name: sha256/bytes $got vs shasum $want"; return
  fi
  if [ -n "$sig" ] && ! jq -e --arg p "$sig" '.signatures | any(startswith($p))' <<<"$body" >/dev/null; then
    bad "$name: signatures $(jq -c .signatures <<<"$body"), want $sig*"; return
  fi
  if [ -z "$sig" ] && [ "$(jq '.signatures | length' <<<"$body")" != 0 ]; then
    bad "$name: unexpected signatures $(jq -c .signatures <<<"$body")"; return
  fi
  if [ -n "$pua" ] && ! jq -e --arg p "$pua" '.pua | any(startswith($p))' <<<"$body" >/dev/null; then
    bad "$name: pua $(jq -c .pua <<<"$body"), want $pua*"; return
  fi
  if [ -z "$pua" ] && [ "$(jq '.pua | length' <<<"$body")" != 0 ]; then
    bad "$name: unexpected pua $(jq -c .pua <<<"$body")"; return
  fi
  ok "$name → $status $(jq -c '[.reason, .signatures, .pua]' <<<"$body") sha256 = shasum"
}

# expect_not_clean <file>: any verdict but clean (and the right sha256) — for objects whose content
# clamd could not fully inspect.
expect_not_clean() {
  local file="$1" body want name
  name="$(basename "$file")"
  body="$(scan "$file")"
  want="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  if [ "$(cat "$work/code")" != 200 ] || [ "$(jq -r .status <<<"$body")" = clean ] || [ "$(jq -r .sha256 <<<"$body")" != "$want" ]; then
    bad "$name → $(cat "$work/code") $body (want anything but clean)"
  else
    ok "$name → $(jq -c '[.status, .reason, .signatures, .pua]' <<<"$body") (not clean)"
  fi
}

# The fixtures are built in the image (make-fixtures.sh); copy them out to send them from here.
names+=(hf-clamav-fx-copy)
docker create --platform linux/amd64 --name hf-clamav-fx-copy "$image" >/dev/null
docker cp -q hf-clamav-fx-copy:/fixtures "$work/fx"
docker rm hf-clamav-fx-copy >/dev/null
fx="$work/fx"
head -c 100000000 /dev/urandom >"$work/random-100mb.bin"

echo "== shipped config (+ the private test signatures)"
start hf-clamav-fx
# clamd logs nothing about PUA at start-up; clamconf reads the effective config.
if grep -qx 'DetectPUA disabled' <<<"$(docker exec hf-clamav-fx clamconf -c /etc/clamav)"; then
  ok "clamconf: DetectPUA disabled"
else
  bad "clamconf does not show DetectPUA disabled"
fi
expect "$fx/clean.txt" clean
expect "$fx/eicar.com" infected Eicar-Test-Signature
expect "$fx/eicar.zip" infected Eicar-Test-Signature
expect "$fx/eicar-zip-in-zip.zip" infected Eicar-Test-Signature
expect "$fx/bomb-20.zip" limits_exceeded Heuristics.Limits.Exceeded.
expect "$fx/password.zip" encrypted Heuristics.Encrypted.
expect "$fx/marker-end.bin" infected Holdfast.Test.Marker
expect "$fx/no-marker.bin" clean
expect "$work/random-100mb.bin" clean
# PUA (review B1): DetectPUA is off, and a PUA.* name that still comes back (a private signature
# fires under DetectPUA no) is never clean — it may be the one name hiding an unscanned member.
expect "$fx/nest17-eicar.zip" limits_exceeded Heuristics.Limits.Exceeded.
expect_not_clean "$fx/pua-only.zip"
for other in password enceicar bomb-20 nest17-eicar; do
  expect_not_clean "$fx/$other-then-pua.zip"
  expect_not_clean "$fx/pua-then-$other.zip"
done
expect "$fx/pua-then-eicar.zip" infected Eicar-Test-Signature
expect "$fx/eicar-then-pua.zip" infected Eicar-Test-Signature
# Control: with an ordinary signature the first member's match is the answer, so the two PUA cases
# above are not explained by member order — clamd does not stop at a PUA match.
expect "$fx/marker-then-eicar.zip" infected Holdfast.Test.Marker
expect "$fx/eicar-then-marker.zip" infected Eicar-Test-Signature

# A body longer than declared → 413; shorter → 400; neither is a verdict.
code="$(curl -s -o "$work/body" -w '%{http_code}' -H 'X-Scan-Size: 10' -H 'Transfer-Encoding: chunked' \
  --data-binary @"$fx/clean.txt" "localhost:$port/scan")"
[ "$code" = 413 ] && ok "declared-size overrun (chunked) → 413" || bad "overrun (chunked) → $code $(cat "$work/body")"
code="$(curl -s -o "$work/body" -w '%{http_code}' -H 'X-Scan-Size: 10' --data-binary @"$fx/clean.txt" "localhost:$port/scan")"
[ "$code" = 413 ] && ok "declared-size overrun (Content-Length) → 413" || bad "overrun (Content-Length) → $code $(cat "$work/body")"
code="$(curl -s -o "$work/body" -w '%{http_code}' -H 'X-Scan-Size: 1000' -H 'Transfer-Encoding: chunked' \
  --data-binary @"$fx/clean.txt" "localhost:$port/scan")"
[ "$code" = 400 ] && ok "short body → 400" || bad "short body → $code $(cat "$work/body")"
code="$(curl -s -o "$work/body" -w '%{http_code}' -H 'X-Scan-Size: 2000000001' --data-binary @"$fx/clean.txt" "localhost:$port/scan")"
[ "$code" = 413 ] && ok "X-Scan-Size 2000000001 → 413" || bad "above the cap → $code"

# Large-slot contention: hold one large scan open on a pipe (the shim has its slot while the body is
# still arriving), then a second large one must be refused busy and a small one must still finish.
mkfifo "$work/pipe"
curl -s -o "$work/first" -w '%{http_code}' -H 'X-Scan-Size: 50000000' -H 'Transfer-Encoding: chunked' \
  -X POST -T - "localhost:$port/scan" <"$work/pipe" >"$work/first-code" &
first=$!
exec 3>"$work/pipe"
head -c 10000000 /dev/urandom >&3
for i in $(seq 1 50); do
  curl -s "localhost:$port/health" | grep -q '"busy":true' && break
  sleep 0.2
done
if curl -s "localhost:$port/health" | grep -q '"busy":true'; then ok "/health busy:true while a large scan runs"; else bad "/health never showed busy"; fi
head -c 9000000 /dev/urandom >"$work/second.bin"
code="$(curl -s -D "$work/headers" -o "$work/body" -w '%{http_code}' -H 'X-Scan-Size: 50000000' \
  --data-binary @"$work/second.bin" "localhost:$port/scan")"
if [ "$code" = 503 ] && jq -e '.status == "busy"' "$work/body" >/dev/null && grep -qi '^retry-after: 15' "$work/headers"; then
  ok "second large scan → 503 busy, Retry-After 15"
else
  bad "second large scan → $code $(cat "$work/body")"
fi
expect "$fx/eicar.com" infected Eicar-Test-Signature # a small scan during the large one
head -c 40000000 /dev/urandom >&3
exec 3>&-
wait "$first"
if [ "$(cat "$work/first-code")" = 200 ] && jq -e '.status == "clean" and .bytes == 50000000' "$work/first" >/dev/null; then
  ok "the held large scan finished clean"
else
  bad "held large scan → $(cat "$work/first-code") $(cat "$work/first")"
fi
if curl -s "localhost:$port/health" | grep -q '"busy":false'; then ok "slot released"; else bad "slot still busy"; fi
stop hf-clamav-fx

echo "== MaxScanTime 1 ms: a cut-off is error/timeout, never limits_exceeded"
start hf-clamav-fx-scantime -e CLAMD_CONF=/etc/clamav/test/clamd-scantime.conf
body="$(scan "$work/random-100mb.bin")"
if [ "$(jq -r '.status + "/" + .reason' <<<"$body")" = error/timeout ]; then
  ok "MaxScanTime cut-off → error/timeout"
else
  bad "MaxScanTime cut-off → $body"
fi
docker logs hf-clamav-fx-scantime 2>&1 | grep -E 'MaxScanTime|status=' | tail -3
stop hf-clamav-fx-scantime

echo "== /scan-tmp too small for the declared size → 503 busy"
start hf-clamav-fx-full --tmpfs /scan-tmp:size=64m,uid=100,gid=101,mode=0750
code="$(curl -s -D "$work/headers" -o "$work/body" -w '%{http_code}' -H 'X-Scan-Size: 100000000' \
  --data-binary @"$work/random-100mb.bin" "localhost:$port/scan")"
if [ "$code" = 503 ] && jq -e '.status == "busy"' "$work/body" >/dev/null && grep -qi '^retry-after: ' "$work/headers"; then
  ok "/scan-tmp full → 503 busy"
else
  bad "/scan-tmp full → $code $(cat "$work/body")"
fi
stop hf-clamav-fx-full

echo "fixtures: $failures failure(s)"
[ "$failures" = 0 ]
