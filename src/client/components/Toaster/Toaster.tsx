import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { hf, layout, shadows } from "../../theme/tokens";
import { dismissToast, getToasts, subscribeToasts, type ToastEntry } from "./store";

const DEFAULT_DURATION = 6000;

function ToastItem({ entry }: { entry: ToastEntry }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(entry.id), entry.duration ?? DEFAULT_DURATION);
    return () => clearTimeout(timer);
  }, [entry.id, entry.duration]);
  return (
    <Box
      data-toast={entry.key ?? "toast"}
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
            dismissToast(entry.id);
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
        onClick={() => dismissToast(entry.id)}
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
