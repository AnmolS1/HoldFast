// Building blocks shared by the auth screens and the re-auth modal.
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import TextField, { type TextFieldProps } from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useId, type ReactNode } from "react";
import { t, type MessageKey } from "../../lib/i18n";
import type { UseTurnstile } from "../../lib/turnstile";
import { hf, layout } from "../../theme/tokens";

/** The card every auth screen sits in. */
export function AuthCard({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <Box
      sx={{
        backgroundColor: hf.surface,
        border: `1px solid ${hf.hairline}`,
        borderRadius: `${layout.radius.card}px`,
        padding: { xs: 5, md: 7 },
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <Typography component="h1" sx={{ margin: 0, fontSize: 18, lineHeight: "24px", fontWeight: 600 }}>
        {title}
      </Typography>
      {lead ? (
        <Typography component="p" sx={{ margin: "-6px 0 0", color: hf.textSecondary }}>
          {lead}
        </Typography>
      ) : null}
      {children}
    </Box>
  );
}

export type FieldProps = Omit<TextFieldProps, "variant" | "error" | "helperText"> & {
  label: string;
  /** Message key of the validation error, if any. */
  errorKey?: MessageKey;
  /** A server-supplied error sentence. */
  errorText?: string;
  help?: ReactNode;
  mono?: boolean;
  /** Label for assistive tech only (the visible label is a legend elsewhere). */
  hideLabel?: boolean;
};

/** A labelled input: the label sits above the box, the error below it and is announced. */
export function Field({ label, errorKey, errorText, help, mono, hideLabel, slotProps, sx, ...rest }: FieldProps) {
  const error = errorKey ? t(errorKey) : errorText;
  return (
    <TextField
      {...rest}
      variant="outlined"
      fullWidth
      label={label}
      error={Boolean(error)}
      helperText={error ?? help}
      slotProps={{
        ...slotProps,
        inputLabel: { shrink: true, ...(slotProps?.inputLabel as object) },
        formHelperText: error ? { role: "alert" } : undefined,
      }}
      sx={{
        // The label is static above the field, not floating inside the outline.
        "& .MuiInputLabel-root": hideLabel
          ? { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", transform: "none" }
          : { position: "static", transform: "none", marginBottom: "6px", maxWidth: "100%" },
        "& .MuiOutlinedInput-notchedOutline": { top: 0 },
        "& .MuiOutlinedInput-notchedOutline legend": { display: "none" },
        ...(mono ? { "& input": { fontFamily: "'Commit Mono', ui-monospace, monospace", fontVariantNumeric: "tabular-nums" } } : {}),
        ...sx,
      }}
    />
  );
}

/** A form-level error, announced as it appears. */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Box role="alert" data-form-error sx={{ color: hf.danger, fontSize: 12, lineHeight: "16px" }}>
      {children}
    </Box>
  );
}

/** A neutral notice above a form ("Email confirmed. Sign in to continue."). */
export function FormNotice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <Box
      role="status"
      data-form-notice
      sx={{ padding: "8px 12px", borderRadius: `${layout.radius.control}px`, backgroundColor: hf.surface2, boxShadow: `inset 2px 0 0 ${tone === "danger" ? hf.danger : hf.textSecondary}`, color: hf.text, fontSize: 12, lineHeight: "16px" }}
    >
      {children}
    </Box>
  );
}

export function OrDivider() {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: "10px", color: hf.textSecondary, fontSize: 12 }}>
      <Box sx={{ flex: "1 1 auto", height: "1px", backgroundColor: hf.hairline }} />
      {t("auth.or")}
      <Box sx={{ flex: "1 1 auto", height: "1px", backgroundColor: hf.hairline }} />
    </Box>
  );
}

/** The Turnstile widget with its status line. The widget itself is the vendor's iframe. */
export function TurnstileBox({ turnstile }: { turnstile: UseTurnstile }) {
  const statusId = useId();
  const { attach, status } = turnstile;
  return (
    <Box data-turnstile={status}>
      <Box ref={attach} aria-describedby={statusId} />
      <Box id={statusId} role="status" sx={{ display: "flex", alignItems: "center", gap: 2, color: status === "error" ? hf.danger : hf.textSecondary, fontSize: 12, minHeight: 16 }}>
        {status === "loading" ? (
          <>
            <CircularProgress size={12} aria-hidden="true" />
            {t("auth.human")}
          </>
        ) : status === "error" ? (
          t("auth.humanFailed")
        ) : null}
      </Box>
    </Box>
  );
}

export function PasskeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
      <circle cx="16.5" cy="7.5" r=".5" />
    </svg>
  );
}

/** The Google "G", in its own brand colours as the vendor requires. */
export function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.5Z" />
      <path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.6 14.7a7.2 7.2 0 0 1 0-4.6V7.2H1.8a12 12 0 0 0 0 10.8l3.8-3.3Z" />
      <path fill="#EA4335" d="M12 4.7c1.7 0 3.2.6 4.4 1.7l3.3-3.3A12 12 0 0 0 1.8 7.2l3.8 3C6.5 7.5 9 4.7 12 4.7Z" />
    </svg>
  );
}
