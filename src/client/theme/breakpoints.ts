import useMediaQuery from "@mui/material/useMediaQuery";

/** The one layout breakpoint: desktop is `>= 1024`, mobile is `< 1024`. */
export const DESKTOP_MIN = 1024;

export const DESKTOP_QUERY = `(min-width:${DESKTOP_MIN}px)`;
export const MOBILE_QUERY = `(max-width:${DESKTOP_MIN - 0.05}px)`;
/** Rows are 48 px when the layout is mobile or the primary pointer is coarse. */
export const TOUCH_QUERY = `${MOBILE_QUERY}, (pointer: coarse)`;

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY, { noSsr: true });
}
