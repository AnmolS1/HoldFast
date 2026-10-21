#!/usr/bin/env bash
# Fills containers/clamav/cvd/ with main.cvd, daily.cvd and bytecode.cvd for a local image build:
# one `freshclam` run in a throwaway container of the pinned base image. ClamAV's CDN rate-limits
# frequent downloaders (PLAN C26) — run it once and keep the files; CI fills the directory from the
# dev bucket's b/clamav/ cache instead. The directory is gitignored (containers/clamav/.gitignore).
#   containers/clamav/fetch-cvd.sh            (Docker must be running; on a Mac export DOCKER_CONTEXT first)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
base="$(sed -n 's/^FROM \(clamav\/clamav:[^ ]*\) AS runtime$/\1/p' "$here/Dockerfile")"
[ -n "$base" ] || { echo "fetch-cvd: no 'FROM clamav/clamav:… AS runtime' line in $here/Dockerfile" >&2; exit 1; }
mkdir -p "$here/cvd"
docker run --rm --platform linux/amd64 -v "$here/cvd:/var/lib/clamav" --entrypoint sh "$base" -c \
  'chown clamav:clamav /var/lib/clamav && freshclam --stdout --foreground --config-file=/etc/clamav/freshclam.conf'
for f in main.cvd daily.cvd bytecode.cvd; do
  [ -s "$here/cvd/$f" ] || { echo "fetch-cvd: $f is missing after freshclam" >&2; exit 1; }
done
ls -l "$here/cvd"
