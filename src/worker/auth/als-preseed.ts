// Mitigation for Better Auth issue #10315 (isolate hang after an aborted request).
//
// `@better-auth/core/dist/async_hooks/index.mjs` creates a module-scope promise
// (`import("node:async_hooks")…`) when it is evaluated, and its three consumers
// (context/request-state, context/transaction, context/endpoint-context) await that promise
// unless the storage they need ALREADY EXISTS on `globalThis[Symbol.for("better-auth:global")]`.
// On a deployed Worker a module-scope promise that an aborted request left pending never settles,
// and every later request in the isolate hangs on it.
//
// This module creates the three storages from a STATIC `node:async_hooks` import, so Better Auth
// finds them and never awaits its own loader. It must be evaluated BEFORE any `better-auth`
// module: it is the first import of create-auth.ts, which the Worker entry imports first and
// statically. Two invariants keep the unmitigated loader safe as well and must not be broken:
//   (i)  Better Auth is imported statically from the Worker entry — never a dynamic `import()`
//        of a module that pulls in `better-auth`;
//   (ii) `betterAuth()` is built per request and never cached on the isolate.
//
// tests/unit/auth/c2-preseed.test.ts proves the storages Better Auth uses ARE these instances
// (and fails when the import is removed), and guards the three key names against an upgrade.

import { AsyncLocalStorage } from "node:async_hooks";

const KEY = Symbol.for("better-auth:global");
type Bag = { version: string; epoch: number; context: Record<string, unknown> };
const g = globalThis as unknown as Record<symbol, Bag | undefined>;
// The same shape core creates; a version mismatch only bumps `epoch`.
const bag = (g[KEY] ??= { version: "1.7.7", epoch: 1, context: {} });

export const seeded = {
  requestStateAsyncStorage: new AsyncLocalStorage(),
  adapterAsyncStorage: new AsyncLocalStorage(),
  endpointContextAsyncStorage: new AsyncLocalStorage(),
};
for (const [k, v] of Object.entries(seeded)) bag.context[k] ??= v;
