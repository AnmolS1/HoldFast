// Types for Worker tests: the `cloudflare:test` helpers and the value this harness provides.
/// <reference types="@cloudflare/vitest-plugin/types" />

import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    /** This checkout's local database name (HOLDFAST_DB). */
    holdfastDb: string;
  }
}
