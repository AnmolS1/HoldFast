export function normaliseHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
  origins?: { appOrigin?: string | null; filesOrigin?: string | null; sentryOrigin?: string | null },
): Record<string, string>;
