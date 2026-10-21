#!/usr/bin/env bash
# The scanner at the product cap (T20 steps 4 and 5), on the instance shape: --memory 4g --cpus 0.5.
# Builds the image's `test` target (it carries the private marker signature), runs it with no contact
# to the signature mirror, and checks:
#   - 2,000,000,000 random bytes → clean, bytes 2000000000, sha256 = shasum, inside 12 minutes;
#   - the same size with the private marker in its last 31 bytes → infected with the marker (read to the end);
#   - X-Scan-Size 2,000,000,001 → 413 before the body is read;
#   - clamd load time on the shape, and how long a RELOAD blocks scans (idle, and during a cap scan);
#   - peaks: clamd RSS (VmHWM), container memory (cgroup memory.peak), /scan-tmp use.
# Heavy (two 2 GB files, a 4 GiB container): run it through holdfast-plan/scripts/heavy.sh cap.
# On an Apple-silicon Mac the image is EMULATED: durations are not representative, memory and disk are.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image=hf-clamav-test
name=hf-clamav-cap
port="${CAP_PORT:-18622}"
cap=2000000000
work="$(mktemp -d)"
failures=0
sampler=""

cleanup() {
  [ -n "$sampler" ] && kill "$sampler" 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; failures=$((failures + 1)); }

docker info >/dev/null 2>&1 || { echo "cap: Docker is not available" >&2; exit 2; }
docker build -q --platform linux/amd64 --target test -t "$image" "$here" >/dev/null
marker_hex="$(sed -n 's/^Holdfast\.Test\.Marker:0:\*://p' "$here/test/holdfast-test.ndb")"

echo "== files"
head -c "$cap" /dev/urandom >"$work/clean.bin"
head -c $((cap - 31)) "$work/clean.bin" >"$work/marker.bin"
printf '%s' "$marker_hex" | xxd -r -p >>"$work/marker.bin"
ls -l "$work"/*.bin | awk '{print $5, $NF}'
clean_sha="$(shasum -a 256 "$work/clean.bin" | cut -d' ' -f1)"
marker_sha="$(shasum -a 256 "$work/marker.bin" | cut -d' ' -f1)"

echo "== start on the instance shape"
docker rm -f "$name" >/dev/null 2>&1 || true
started=$(date +%s)
docker run -d --platform linux/amd64 --name "$name" --memory 4g --cpus 0.5 -e SCANNER_OFFLINE=1 \
  -p "127.0.0.1:$port:8080" "$image" >/dev/null
until curl -sf "localhost:$port/health" 2>/dev/null | grep -q '"ready":true'; do
  [ $(($(date +%s) - started)) -lt 600 ] || { bad "never ready"; docker logs "$name" | tail; exit 1; }
  sleep 1
done
echo "clamd loaded and /health ready $(($(date +%s) - started)) s after docker run (emulated)"
docker exec "$name" sh -c 'grep VmHWM /proc/$(pidof clamd)/status; echo "cgroup memory.peak after load: $(( $(cat /sys/fs/cgroup/memory.peak) / 1048576 )) MiB"'
docker exec "$name" sh -c 'df -m /scan-tmp; grep -E " / | /scan-tmp " /proc/mounts | cut -c1-60'

# Sampler: clamd RSS, container memory and /scan-tmp use every 2 s.
(
  while true; do
    docker exec "$name" sh -c 'echo "$(date +%s) $(awk "/VmRSS/{print \$2}" /proc/$(pidof clamd)/status) $(cat /sys/fs/cgroup/memory.current) $(du -sk /scan-tmp | cut -f1)"' 2>/dev/null || true
    sleep 2
  done
) >"$work/samples" &
sampler=$!

# post <file> <declared size> → response body in $work/body, status in $work/code, seconds in $work/secs
post() {
  local t0=$(date +%s)
  curl -s -o "$work/body" -w '%{http_code} %{size_upload}' -X POST -H "X-Scan-Size: $2" -T "$1" \
    "localhost:$port/scan" >"$work/code" || true # a refusal before the body ends curl's upload with an error
  echo $(($(date +%s) - t0)) >"$work/secs"
}

echo "== 2,000,000,000 random bytes"
post "$work/clean.bin" "$cap"
echo "$(cat "$work/code") $(cat "$work/secs") s: $(cat "$work/body")"
if jq -e --arg s "$clean_sha" '.status == "clean" and .bytes == 2000000000 and .sha256 == $s' "$work/body" >/dev/null &&
  [ "$(cat "$work/secs")" -le 720 ]; then
  ok "cap-sized random → clean, bytes 2000000000, sha256 = shasum, $(cat "$work/secs") s (emulated)"
else
  bad "cap-sized random (want clean, sha $clean_sha, ≤ 720 s)"
fi

echo "== 2,000,000,000 bytes, private marker in the last 31 bytes"
post "$work/marker.bin" "$cap"
echo "$(cat "$work/code") $(cat "$work/secs") s: $(cat "$work/body")"
if jq -e --arg s "$marker_sha" '.status == "infected" and (.signatures | any(startswith("Holdfast.Test.Marker"))) and .sha256 == $s' \
  "$work/body" >/dev/null; then
  ok "marker in the last 31 bytes → infected Holdfast.Test.Marker, $(cat "$work/secs") s (emulated)"
else
  bad "marker at the end not found"
fi

echo "== X-Scan-Size 2,000,000,001"
head -c $((cap + 1)) /dev/zero >"$work/over.bin"
post "$work/over.bin" $((cap + 1))
read -r code uploaded <"$work/code" || true # curl -w writes no newline
echo "$code, uploaded $uploaded bytes, $(cat "$work/secs") s: $(cat "$work/body")"
if [ "$code" = 413 ] && [ "$uploaded" -lt 100000000 ]; then
  ok "one byte over the cap → 413 before the body was read ($uploaded bytes left curl)"
else
  bad "over the cap → $code after $uploaded bytes"
fi
rm -f "$work/over.bin"

now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }
since() { perl -e 'printf "%.1f", $ARGV[1] - $ARGV[0]' "$1" "$(now)"; }
printf '%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR' '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' >"$work/eicar.com"
# small_after_reload <label>: RELOAD, then EICAR scans once a second until one is answered with a
# verdict. While clamd reloads (ConcurrentDatabaseReload no) it answers no PING, so the shim answers
# 503 not_ready (clamd_loading) instead of letting a scan hang: the time to the first verdict is how
# long scans are held up.
small_after_reload() {
  local t0 refused=0 code
  t0=$(now)
  docker exec "$name" clamdscan --config-file=/etc/clamav/clamd.conf --reload
  while :; do
    code="$(curl -s --max-time 900 -o "$work/small" -w '%{http_code}' -X POST -H 'X-Scan-Size: 68' \
      --data-binary @"$work/eicar.com" "localhost:$port/scan" || true)"
    [ "$code" = 200 ] && break
    refused=$((refused + 1))
    [ "$(perl -e 'print int($ARGV[1] - $ARGV[0])' "$t0" "$(now)")" -lt 900 ] || break
    sleep 1
  done
  echo "$1: first verdict after RELOAD $(since "$t0") s later ($refused answers 503 before it): $(jq -c '[.status, .signatures]' "$work/small" 2>/dev/null)"
  jq -e '.status == "infected"' "$work/small" >/dev/null || bad "$1: EICAR after RELOAD → $(cat "$work/small")"
}

echo "== RELOAD while idle (ConcurrentDatabaseReload no)"
small_after_reload "idle (emulated)"

echo "== RELOAD during a cap-sized scan"
post "$work/clean.bin" "$cap" &
scan=$!
until docker exec "$name" du -sk /scan-tmp 2>/dev/null | awk '{exit !($1 > 500000)}'; do sleep 1; done
small_after_reload "500 MB into a cap-sized scan's spool (emulated)"
wait "$scan"
echo "$(cat "$work/code") $(cat "$work/secs") s: $(cat "$work/body")"
if jq -e --arg s "$clean_sha" '.status == "clean" and .sha256 == $s' "$work/body" >/dev/null; then
  ok "the scan interrupted by a RELOAD still finished clean"
else
  bad "scan during RELOAD"
fi

kill "$sampler"; sampler=""
echo "== peaks"
docker exec "$name" sh -c 'grep VmHWM /proc/$(pidof clamd)/status; echo "cgroup memory.peak: $(( $(cat /sys/fs/cgroup/memory.peak) / 1048576 )) MiB of $(( $(cat /sys/fs/cgroup/memory.max) / 1048576 )) MiB"'
awk 'BEGIN{r=0;m=0;d=0} {if($2>r)r=$2; if($3>m)m=$3; if($4>d)d=$4} END{printf "sampled peaks: clamd RSS %d MiB, container memory %d MiB, /scan-tmp %d MiB (%d samples)\n", r/1024, m/1048576, d/1024, NR}' "$work/samples"
docker logs "$name" 2>&1 | grep -E 'scan bytes=|reload|Reading databases|Database' | tail -14 || true

echo "cap: $failures failure(s)"
[ "$failures" = 0 ]
