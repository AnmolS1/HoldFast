/** Clamp into 0..1 and never below the highest value seen. Pure; exported for the unit test. */
export function clampForward(previous: number, next: number): number {
  const bounded = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0;
  return Math.max(previous, bounded);
}
