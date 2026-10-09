// PLACEHOLDER — taken over by the abuse-controls task (T22), which keeps the name and props.
//
// The stub passes straight through: it calls `onContinue()` on mount, so there is NO gate until
// the real component lands. It must never reach a deploy that serves public links.
import { useEffect } from "react";
import type { DangerousFileInterstitialProps } from "../../components/slots";

export { routes } from "./routes";

export function DangerousFileInterstitial({ onContinue }: DangerousFileInterstitialProps): null {
  useEffect(() => {
    onContinue();
    // Once, on mount: the stub is a pass-through, not a subscription to the callback's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
