// Client addresses of the e2e suite's own (the `clientIp` fixture, the role fixtures).

/** A stable private address per test and attempt: 10.x.y.z from a hash of the test's id. */
export function addressFor(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bytes = hash >>> 0;
  return `10.${(bytes >>> 16) & 255}.${(bytes >>> 8) & 255}.${bytes & 255}`;
}
