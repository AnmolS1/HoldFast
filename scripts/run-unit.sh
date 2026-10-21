#!/usr/bin/env bash
# `npm test`: the three unit steps. Each runs even when an earlier one failed (a red step 2 must
# not hide what step 3 would have said), and the run fails if any step did.
#   1. jsdom + node (vitest.config.ts)
#   2. Workers (vitest.workers.config.ts)
#   3. the table-wide Workers files, one at a time (HOLDFAST_TABLEWIDE=1). No --passWithNoTests:
#      a step 3 that finds no files is a broken selection, not a pass.
set -u
failed=()
vitest run -c vitest.config.ts || failed+=("1 (jsdom + node)")
vitest run -c vitest.workers.config.ts || failed+=("2 (workers)")
HOLDFAST_TABLEWIDE=1 vitest run -c vitest.workers.config.ts || failed+=("3 (table-wide)")
if [ ${#failed[@]} -gt 0 ]; then
  printf 'npm test: step %s failed\n' "${failed[@]}" >&2
  exit 1
fi
