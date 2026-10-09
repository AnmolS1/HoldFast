import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { hf, layout, motion, shadows } from "../../theme/tokens";

export interface BottomSheetProps {
  open: boolean;
  onClose(): void;
  /** Names the dialog. */
  title: string;
  /** Shown under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Hide the visible title (it still names the dialog). */
  hideTitle?: boolean;
}

/** The mobile container for details and actions: a modal sheet from the bottom edge. */
export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  hideTitle = false,
}: BottomSheetProps) {
  const titleId = useId();
  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      transitionDuration={motion.sheet}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": titleId,
          sx: {
            borderRadius: `${layout.radius.sheet}px ${layout.radius.sheet}px 0 0`,
            boxShadow: shadows.sheet,
            maxHeight: "86dvh",
            paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          },
        },
      }}
    >
      <Box
        aria-hidden="true"
        sx={{
          width: 36,
          height: 4,
          borderRadius: "2px",
          backgroundColor: hf.illustration,
          margin: "8px auto 4px",
        }}
      />
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          padding: "4px 8px 4px 20px",
          minHeight: layout.touchTarget,
        }}
      >
        <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
          <Typography
            id={titleId}
            component="h2"
            sx={
              hideTitle
                ? {
                    position: "absolute",
                    width: 1,
                    height: 1,
                    overflow: "hidden",
                    clip: "rect(0 0 0 0)",
                    whiteSpace: "nowrap",
                  }
                : { margin: 0, fontSize: 16, lineHeight: "22px", fontWeight: 600, overflowWrap: "anywhere" }
            }
          >
            {title}
          </Typography>
          {subtitle ? <Box sx={{ color: hf.textSecondary, fontSize: 12 }}>{subtitle}</Box> : null}
        </Box>
        <IconButton
          aria-label={t("app.close")}
          onClick={onClose}
          sx={{ width: layout.touchTarget, height: layout.touchTarget, flex: "none" }}
        >
          <X size={20} aria-hidden="true" />
        </IconButton>
      </Box>
      <Box sx={{ overflowY: "auto", padding: "0 8px" }}>{children}</Box>
    </Drawer>
  );
}
