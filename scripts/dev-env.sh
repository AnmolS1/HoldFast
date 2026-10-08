#!/usr/bin/env bash
# Writes this checkout's .dev.vars (mode 600) from .dev.vars.example, for ONE port.
#
#   scripts/dev-env.sh <port> [source .dev.vars]
#
# APP_ORIGIN and FILES_ORIGIN are set for <port>. Secret values are carried over from the source
# file when one is given, or from this checkout's existing .dev.vars when it is not, so re-running
# for another port never wipes locally generated secrets. Everything else comes from the example:
# a checkout always gets the Turnstile test pair, EMAIL_TRANSPORT=memory and SCAN_STUB=1.
#
# A checkout has exactly one .dev.vars and therefore exactly one port. This script never prints a value.
set -euo pipefail
umask 077

usage() {
  echo "usage: scripts/dev-env.sh <port> [source .dev.vars]" >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
port="$1"
case "$port" in
  '' | *[!0-9]*) usage ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  echo "dev-env: port must be between 1024 and 65535" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
example="$root/.dev.vars.example"
target="$root/.dev.vars"
source_file="${2:-}"

[ -f "$example" ] || { echo "dev-env: missing .dev.vars.example" >&2; exit 1; }
if [ -n "$source_file" ]; then
  [ -f "$source_file" ] || { echo "dev-env: source file not found" >&2; exit 1; }
elif [ -f "$target" ]; then
  source_file="$target"
fi
# An empty source carries nothing over (and would confuse the two-pass read below).
if [ -n "$source_file" ] && [ ! -s "$source_file" ]; then source_file=""; fi

# Only these keys are carried over. The Turnstile pair is deliberately not: a real secret next to
# the test sitekey (or the reverse) fails every verification.
carry="BETTER_AUTH_SECRET FILES_TOKEN_SECRET IP_ENC_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET RESEND_API_KEY SENTRY_DSN ADMIN_EMAILS PHOTODNA_SUBSCRIPTION_KEY CF_ANALYTICS_TOKEN"

tmp="$(mktemp "$root/.dev.vars.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# Pass 1 reads the source (if any) into memory; pass 2 rewrites the example. The source is fully
# read before the target is replaced, so the source may be the target itself.
carried="$(
  awk -v port="$port" -v carry="$carry" -v out="$tmp" -v have_source="$([ -n "$source_file" ] && echo 1 || echo 0)" '
    BEGIN { n = split(carry, names, " "); for (i = 1; i <= n; i++) wanted[names[i]] = 1; count = 0 }
    function key_of(line,   i) { i = index(line, "="); return i ? substr(line, 1, i - 1) : "" }
    have_source == 1 && FNR == NR {
      if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
      k = key_of($0); v = substr($0, index($0, "=") + 1)
      if ((k in wanted) && v != "") value[k] = v
      next
    }
    {
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
        k = key_of($0)
        if (k == "APP_ORIGIN") { print "APP_ORIGIN=http://localhost:" port > out; next }
        if (k == "FILES_ORIGIN") { print "FILES_ORIGIN=http://files.localhost:" port > out; next }
        if (k in value) { print k "=" value[k] > out; count++; next }
      }
      print $0 > out
    }
    END { print count }
  ' ${source_file:+"$source_file"} "$example"
)"

chmod 600 "$tmp"
mv -f "$tmp" "$target"
trap - EXIT
echo "dev-env: wrote .dev.vars for port $port ($carried secret value(s) carried over)"
