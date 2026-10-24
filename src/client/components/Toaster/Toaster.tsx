import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import { X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { hf, layout, shadows } from "../../theme/tokens";
import { dismissToast, getToasts, subscribeToasts, type ToastEntry } from "./store";

/** How long a toast — the shell's standard status message — stays, in ms. */
export const DEFAULT_DURATION = 6000;

/**
 * One toast. Its time runs only while neither the keyboard focus nor the pointer is on it (WCAG
 * 2.2.1, R1 a11y-5): entering pauses it, and the rest runs once both have left. A button pressed
 * in it hands the focus back to where it came from, so it does not fall to <body> (a11y-1).
 */
function ToastItem({ entry }: { entry: ToastEntry }) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const held = focused || hovered;
  const left = useRef(entry.duration ?? DEFAULT_DURATION);
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(entry.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [entry.id, held]);
  const close = () => {
    const back = returnTo.current;
    dismissToast(entry.id);
    if (focused && back?.isConnected) back.focus();
  };
  return (
    <Box
      data-toast={entry.key ?? "toast"}
      onFocus={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) returnTo.current = from;
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "6px 6px 6px 14px",
        minHeight: 40,
        maxWidth: 480,
        borderRadius: `${layout.radius.card}px`,
        backgroundColor: hf.primaryButton,
        color: hf.primaryButtonText,
        boxShadow: shadows.toast,
        pointerEvents: "auto",
      }}
    >
      {entry.icon}
      <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
        {entry.message}
        {entry.requestId ? (
          <>
            {" "}
            <Box component="span" className="mono" sx={{ opacity: 0.8 }}>
              {t("app.requestId", { id: entry.requestId })}
            </Box>
          </>
        ) : null}
      </Box>
      {entry.action ? (
        <Button
          variant="text"
          onClick={() => {
            entry.action?.onClick();
            close();
          }}
          sx={{
            color: "inherit",
            fontWeight: 600,
            textDecoration: "underline",
            "&:hover": { backgroundColor: "transparent", color: "inherit", opacity: 0.85 },
          }}
        >
          {entry.action.label}
        </Button>
      ) : null}
      <IconButton
        aria-label={t("toast.dismiss")}
        onClick={close}
        sx={{ color: "inherit", "&:hover": { backgroundColor: "transparent", opacity: 0.8 } }}
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

/** The toast region: one polite live region, newest at the bottom. Mounted once at the app root. */
export function Toaster() {
  const entries = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <Box
      role="status"
      aria-live="polite"
      data-toaster
      sx={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: "calc(16px + var(--hf-bottom-inset, 0px))",
        zIndex: (theme) => theme.zIndex.snackbar,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 2,
        pointerEvents: "none",
      }}
    >
      {entries.map((entry) => (
        <ToastItem key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}
