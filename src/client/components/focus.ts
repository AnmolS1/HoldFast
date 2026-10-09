import { useEffect, useRef, type RefObject } from "react";

/**
 * Focus an element when the component that owns it mounts — for the first field of a modal.
 *
 * Use this instead of the `autoFocus` attribute inside a dialog. `autoFocus` focuses once, when
 * the DOM node is created; the dialog's focus trap is an effect, and whenever that effect is
 * torn down and run again (React's strict-mode double invocation, a fast refresh) it hands focus
 * back to the opener and then, finding nothing focused inside, parks it on the dialog itself.
 * An effect re-runs together with the trap's, so the field ends up focused every time.
 */
export function useInitialFocus<T extends HTMLElement>(enabled = true): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);
  return ref;
}
