# syntax=docker/dockerfile:1
#
# Holdfast virus scanner (T20): clamd + freshclam + an HTTP shim on :8080, run as the ScannerContainer
# Durable Object's container (src/worker/scan/container.ts). linux/amd64 only — clamav/clamav has no
# arm64 build; an Apple-silicon Mac builds and runs it emulated (`--platform linux/amd64`).
#
# Base: clamav/clamav:stable_base, pinned by its index digest below (ClamAV 1.5.4 on 2026-10-21). It
# ships clamd and freshclam and no signatures.
#
# Size limits (clamd.conf): StreamMaxLength / MaxFileSize 2000M. clamd reads the M suffix as 2^20
# ("File size limit set to 2097152000 bytes" in its start-up log, spike S2), so both are
# 2,097,152,000 bytes: at least the 2,000,000,000-byte product cap and below 2^31. clamd therefore
# does NOT enforce the product cap (it scanned 2,000,000,001 bytes, and refused 2,097,152,001 only
# after reading all of it); the shim refuses X-Scan-Size > 2,000,000,000 with 413 before reading.
# MaxScanTime 600000 (the 120 s default cut a clean cap-sized scan off on standard-1); the shim maps
# Heuristics.Limits.Exceeded.MaxScanTime to { status: 'error', reason: 'timeout' }, never to
# limits_exceeded. TemporaryDirectory /scan-tmp is on the instance disk: INSTREAM spools the whole
# stream there (~2 GB for a cap-sized scan) — never a tmpfs.
#
# Signature cache (C26): the build never fetches signatures. It COPYs main.cvd, daily.cvd and
# bytecode.cvd from cvd/ (gitignored: containers/clamav/.gitignore). Locally, fill it once with
# containers/clamav/fetch-cvd.sh. In CI it is filled from the dev bucket holdfast-files-dev under
# b/clamav/ (also for the prod build), refreshed from ClamAV's CDN at most once a day.
#
# Freshness gate (R2.30): the disk is ephemeral, so every wake starts from the baked signatures. POST
# /scan answers 503 { status: 'not_ready', reason: 'signatures' | 'clamd_loading', dbAgeHours } with
# Retry-After: 30 until clamd answers PING and either (a) the first freshclam run since boot succeeded
# and clamd has reloaded what it fetched, or (b) the loaded daily database is younger than
# SIG_FRESH_HOURS (below; its age comes from the build time clamd reports for the loaded daily). One
# freshclam run per wake; daemon mode (Checks 12) starts 2 h after boot. No keep-warm: nothing pings
# the container on a schedule.
#
# Endpoints: POST /scan (body streamed to clamd with INSTREAM, SHA-256 in the same pass, header
# X-Scan-Size required; one large scan > 8 MiB per instance and four small ones, more → 503 busy with
# Retry-After: 15 before any body byte is read) and GET /health (always 200, never scans). A refusal
# made before the body is read also states its outcome in headers (X-Scan-Status busy|not_ready,
# X-Scan-Reason, X-Scan-Db-Age-Hours): the connection closes with the upload unread and the caller
# can lose the JSON body.
#
# Environment: SIG_FRESH_HOURS (24); SCANNER_OFFLINE=1 skips freshclam entirely (local test runs only —
# fail-closed: a stale bake then never becomes ready); CLAMD_CONF selects another clamd config (the
# test target's tiny-MaxScanTime one).
#
# Workflow needs (T09c's .github/workflows/scanner-image.yml; reported to the orchestrator, not edited here):
#   1. Scheduled rebuild for BOTH dev and prod. This file is the real scanner: the placeholder guard
#      can come off. Cadence: see the T20 report.
#   2. CVD cache step before any image build: pull b/clamav/*.cvd from holdfast-files-dev into
#      containers/clamav/cvd/; if missing or older than 24 h, run freshclam once on the runner and
#      write the files back.
#   3. Image reuse (R2.31): when containers/** is unchanged and it is not the scheduled rebuild, the
#      deploy rewrites containers[].image to the registry reference of the last pushed image, since
#      `wrangler deploy` always builds a Dockerfile path.
#
# Targets: the default (last) stage is the shipped image. `--target test` adds test-only material:
# a private signature file (test/holdfast-test.ndb), fixtures, and a clamd config with a tiny
# MaxScanTime. The shim's Go tests run in the `shim` stage, so a red test fails every build.
#
# Integration run (containers enabled in a local `wrangler dev`, the only place they are):
#   containers/clamav/test/integration.sh      (exits non-zero when Docker or containers are unavailable)

ARG CLAMAV_BASE=clamav/clamav:stable_base@sha256:751df8dc649cc977696f107c80db4960b6317a7cb511aebc8066f3b91db6b631

FROM --platform=$BUILDPLATFORM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS shim
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY shim/ ./
RUN test -z "$(gofmt -l .)" \
 && go vet ./... \
 && go test -count=1 ./... \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/hf-scanner .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS fixtures
RUN apk add --no-cache zip
COPY test/make-fixtures.sh test/holdfast-test.ndb /build/
RUN /build/make-fixtures.sh /fixtures /build/holdfast-test.ndb

FROM ${CLAMAV_BASE} AS runtime
ENV TZ=Etc/UTC \
    SIG_FRESH_HOURS=24
COPY clamd.conf freshclam.conf freshclam-boot.conf /etc/clamav/
COPY --from=shim /out/hf-scanner /usr/local/bin/hf-scanner
COPY --chown=clamav:clamav cvd/main.cvd cvd/daily.cvd cvd/bytecode.cvd /var/lib/clamav/
RUN install -d -o clamav -g clamav -m 750 /scan-tmp \
 && install -d -o clamav -g clamav -m 755 /run/clamav
USER clamav
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/hf-scanner"]

FROM runtime AS test
USER root
COPY --from=fixtures /fixtures /fixtures
COPY --chown=clamav:clamav test/holdfast-test.ndb /var/lib/clamav/
RUN install -d /etc/clamav/test \
 && sed 's/^MaxScanTime .*/MaxScanTime 1/' /etc/clamav/clamd.conf > /etc/clamav/test/clamd-scantime.conf \
 && grep -q '^MaxScanTime 1$' /etc/clamav/test/clamd-scantime.conf
USER clamav

FROM runtime
