#!/usr/bin/env bash
# The performance smoke (T28 Scope 6), locally, on a BUILT app — `vite dev`'s unbundled modules are
# not what a visitor gets:
#   1. `vite build --manifest`, then the bundle budgets (scripts/lhci/budgets.ts);
#   2. `vite preview` on this checkout's port and database (the built Worker in workerd);
#   3. a verified user (scripts/lhci/seed-user.ts), signed in before `/` by sign-in.cjs;
#   4. Lighthouse CI (desktop) on /login and /, three runs each, asserted by lighthouserc.json on the
#      MEDIAN run (performance ≥ 0.90, accessibility ≥ 0.95); reports under coverage/lhci/.
# Run in a worktree shell after `eval "$(scripts/dev-worktree.sh <task>)"`, with no dev server up.
# Exit status: non-zero if the budgets or the assertions failed (both are always run).
set -u
cd "$(dirname "$0")/../.."
: "${HOLDFAST_PORT:?eval \"\$(scripts/dev-worktree.sh <task>)\" first}"
: "${HOLDFAST_DB:?eval \"\$(scripts/dev-worktree.sh <task>)\" first}"
port="$HOLDFAST_PORT"
work="$(mktemp -d)"
failed=()
server=""
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

npx vite build --manifest >"$work/build.log" 2>&1 || { tail -20 "$work/build.log"; exit 1; }
npx tsx scripts/lhci/budgets.ts dist/client || failed+=("budgets")

# The same environment Playwright gives its dev server (playwright.config.ts `localServer`); the
# database URL from the one place that spells it (tests/setup/local-env.ts `localDbUrl`), never
# printed.
db_url="$(npx tsx -e 'import("./tests/setup/local-env.ts").then(({ localDbUrl }) => process.stdout.write(localDbUrl()))')"
[ -n "$db_url" ] || { echo "lhci: no local database URL"; exit 1; }
HOLDFAST_DEV_PORT="$port" CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$db_url" \
  npx vite preview --port "$port" --strictPort >"$work/preview.log" 2>&1 &
server=$!
for _ in $(seq 1 120); do
  curl -fsS -o /dev/null "http://localhost:$port/__meta" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://localhost:$port/__meta" || { echo "lhci: the preview server did not come up"; tail -20 "$work/preview.log"; exit 1; }

npx tsx scripts/lhci/seed-user.ts "$work/credentials.json" || { echo "lhci: no seeded user"; exit 1; }
chrome="$(node -e 'process.stdout.write(require("playwright-core").chromium.executablePath())')"
rm -rf .lighthouseci
LHCI_CREDENTIALS="$work/credentials.json" npx lhci collect --config=lighthouserc.json \
  --url="http://localhost:$port/login" --url="http://localhost:$port/" --chromePath="$chrome" || failed+=("collect")
npx lhci assert --config=lighthouserc.json || failed+=("assert")
npx lhci upload --config=lighthouserc.json >/dev/null || true
# LHCI's own working directory is not kept in the checkout (the reports are under coverage/lhci).
rm -rf .lighthouseci

if [ ${#failed[@]} -gt 0 ]; then
  printf 'lhci: %s failed\n' "${failed[@]}" >&2
  exit 1
fi
