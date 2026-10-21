// The real scanner behind `getScanner` (services/scanning.ts) when the stub is off: T20's helpers
// (scan/container.ts) adapted to the `Scanner` interface. It never retries and never catches —
// `ScannerBusyError`, `ScannerNotReadyError`, `ScannerTransportError` and `ScannerRefusedError`
// pass through to the caller, which decides (the consumer's table; `scanSmallObject`'s `error`).
//
// The shim's verdict maps to `ScanVerdict`:
//   clean            → clean
//   infected         → infected
//   limits_exceeded  → skipped / limits
//   encrypted        → skipped / encrypted
//   error            → error / timeout | engine   (MaxScanTime arrives here as `timeout`; a PUA
//                                                   match as `engine` — T20 B1. Never a verdict
//                                                   the consumer writes: it is retried.)
// The shim's `sha256` is the SERVER's hash of the bytes it read, and is always carried.

import type { ScanVerdict, Scanner } from "../services/scanning";
import { scanObject, type ScannerDeps, scanSmall, type ShimVerdict } from "./container";

export function verdictOf(shim: ShimVerdict): ScanVerdict {
  const common = {
    signatures: shim.signatures,
    pua: shim.pua,
    sha256: shim.sha256,
    bytes: shim.bytes,
    engine: shim.engine,
    dbVersion: shim.dbVersion,
    durationMs: shim.durationMs,
  };
  switch (shim.status) {
    case "clean":
      return { status: "clean", ...common };
    case "infected":
      return { status: "infected", ...common };
    case "limits_exceeded":
      return { status: "skipped", reason: "limits", ...common };
    case "encrypted":
      return { status: "skipped", reason: "encrypted", ...common };
    default:
      // `error`, and anything this build does not know: never clean.
      return { status: "error", reason: shim.reason === "timeout" ? "timeout" : "engine", ...common };
  }
}

/** The adapter. `deps` is T20's test seam (a fake container); production passes nothing. */
export function scannerOver(env: Pick<Env, "SCANNER">, deps?: ScannerDeps): Scanner {
  return {
    async scanStream(body, meta) {
      return verdictOf(await scanObject(env, { key: meta.key, size: meta.size, body }, deps));
    },
    async scanBytes(bytes) {
      return verdictOf(await scanSmall(env, bytes, deps));
    },
  };
}
