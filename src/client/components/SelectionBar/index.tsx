import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { shortcutLabel, type ShortcutId } from "../../lib/shortcuts";
import { hf, hfAccent, layout, motion } from "../../theme/tokens";
import { Kbd } from "../Kbd";

export interface SelectionBarProps {
  /** Number of selected items; the bar renders nothing at 0. */
  count: number;
  /** `<SelectionBarAction>` buttons, supplied by the feature. */
  actions?: ReactNode;
  onClear(): void;
}

export interface SelectionBarActionProps {
  label: string;
  onClick(): void;
  /** Shows the key next to the label. */
  shortcut?: ShortcutId;
  disabled?: boolean;
  /** "Move to trash" is the one destructive action that takes the danger colour. */
  destructive?: boolean;
}

const actionSx = {
  minHeight: 28,
  padding: "0 10px",
  borderRadius: `${layout.radius.control}px`,
  gap: "6px",
  font: "inherit",
  "&:hover": { backgroundColor: hf.surface },
  "&.Mui-disabled": { color: hf.textSecondary },
  "@media (max-width:1023.95px)": { minHeight: layout.touchTarget },
} as const;

export function SelectionBarAction({
  label,
  onClick,
  shortcut,
  disabled,
  destructive,
}: SelectionBarActionProps) {
  return (
    <ButtonBase
      onClick={onClick}
      disabled={disabled}
      sx={{ ...actionSx, color: destructive ? hf.danger : "inherit" }}
    >
      {label}
      {shortcut ? <Kbd bare>{shortcutLabel(shortcut)}</Kbd> : null}
    </ButtonBase>
  );
}

/**
 * Replaces the toolbar while one or more items are selected. The count is the live count the
 * activity colour is allowed on; a polite live region announces every change.
 */
export function SelectionBar({ count, actions, onClear }: SelectionBarProps) {
  const label = t("selection.count", { count });
  return (
    <>
      <Box
        aria-live="polite"
        role="status"
        data-selection-live
        sx={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {count > 0 ? t("selection.announce", { count }) : ""}
      </Box>
      {count > 0 ? (
        <Box
          role="toolbar"
          aria-label={label}
          data-selection-bar
          sx={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 1,
            padding: "6px 20px",
            borderBottom: `1px solid ${hf.hairline}`,
            backgroundColor: hfAccent.wash,
            "@keyframes hf-selection-in": {
              from: { transform: "translateY(-6px)", opacity: 0 },
              to: { transform: "none", opacity: 1 },
            },
            animation: `hf-selection-in ${motion.fast}ms ease-out`,
          }}
        >
          <Box
            component="span"
            sx={{ display: "inline-flex", alignItems: "center", gap: 2, marginRight: 2, fontWeight: 500 }}
          >
            <Box
              component="span"
              aria-hidden="true"
              sx={{ width: 8, height: 8, borderRadius: "4px", backgroundColor: hfAccent.main }}
            />
            <span className="num">{label}</span>
          </Box>
          {actions}
          <Box sx={{ flex: "1 1 auto" }} />
          <ButtonBase onClick={onClear} sx={{ ...actionSx, color: hf.textSecondary }}>
            {t("selection.clear")}
            <Kbd bare>{shortcutLabel("escape")}</Kbd>
          </ButtonBase>
        </Box>
      ) : null}
    </>
  );
}
