// CONTRACT STUB (contracts-0). Owner: T07 (worker core), which replaces both bodies with the
// redaction rules of its step 12. Until then these are signatures only.
//
// Pure functions with no SDK import, so the browser bundle and the Worker share one copy.
// The stubs throw instead of returning their input: a redactor that passes everything through
// would send tokens to Sentry.

export function redactUrl(url: string): string {
  void url;
  throw new Error("not implemented: T07");
}

export function redactEvent<T>(event: T): T {
  void event;
  throw new Error("not implemented: T07");
}
