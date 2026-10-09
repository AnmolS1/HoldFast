// Cloudflare Turnstile, explicit rendering. The script is loaded once, on the first screen that
// needs it; the token it yields is single-use and goes to the auth endpoints as
// `x-captcha-response`.
import { useCallback, useEffect, useRef, useState } from "react";

export const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "flexible" | "compact";
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve(window.turnstile);
  // A resolved or pending load is reused; a failed one is forgotten so the next screen retries.
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile unavailable"));
    };
    script.onerror = () => reject(new Error("turnstile failed to load"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export type TurnstileStatus = "loading" | "ready" | "error";

export interface UseTurnstile {
  /** Callback ref for the element the widget renders into. */
  attach: (node: HTMLElement | null) => void;
  /** Null until the challenge passes, and again after `reset()` or expiry. */
  token: string | null;
  status: TurnstileStatus;
  /** A token is single-use: call after every submit that spent it. */
  reset(): void;
}

export function useTurnstile(siteKey: string | undefined): UseTurnstile {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>("loading");
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);

  useEffect(() => {
    if (!node || !siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        const id = api.render(node, {
          sitekey: siteKey,
          size: "flexible",
          theme: "auto",
          callback: (value) => {
            setToken(value);
            setStatus("ready");
          },
          "expired-callback": () => {
            setToken(null);
            setStatus("loading");
          },
          "error-callback": () => {
            setToken(null);
            setStatus("error");
          },
        });
        widget.current = { api, id };
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      const current = widget.current;
      widget.current = null;
      if (current) {
        try {
          current.api.remove(current.id);
        } catch {
          // The widget is already gone.
        }
      }
    };
  }, [node, siteKey]);

  const reset = useCallback(() => {
    setToken(null);
    setStatus("loading");
    const current = widget.current;
    if (current) {
      try {
        current.api.reset(current.id);
      } catch {
        setStatus("error");
      }
    }
  }, []);

  return { attach: setNode, token, status, reset };
}
