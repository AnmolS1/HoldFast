import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { X } from "lucide-react";
import { useId } from "react";
import { Kbd } from "../../components/Kbd";
import { LegalFooter } from "../../components/LegalFooter";
import { EXTERNAL_LINKS } from "../../lib/contracts";
import { t } from "../../lib/i18n";
import { SHORTCUTS, shortcutLabels } from "../../lib/shortcuts";
import { hf } from "../../theme/tokens";
import { closeShortcuts, useShortcutsOpen } from "./shortcuts-store";

function ShortcutTable() {
  return (
    <Box
      component="dl"
      sx={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        rowGap: 2,
        columnGap: 6,
        alignItems: "center",
      }}
    >
      {SHORTCUTS.map((shortcut) => (
        <Box key={shortcut.id} sx={{ display: "contents" }}>
          <Box component="dt">{t(shortcut.description)}</Box>
          <Box component="dd" sx={{ margin: 0, display: "flex", gap: 1, justifyContent: "flex-end" }}>
            {shortcutLabels(shortcut.id).map((label) => (
              <Kbd key={label}>{label}</Kbd>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** The `?` overlay. Mounted once in the frame. */
export function ShortcutsDialog() {
  const open = useShortcutsOpen();
  const titleId = useId();
  return (
    <Dialog open={open} onClose={closeShortcuts} aria-labelledby={titleId} maxWidth="xs" fullWidth>
      <DialogTitle
        id={titleId}
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        {t("shortcuts.title")}
        <IconButton aria-label={t("app.close")} onClick={closeShortcuts}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <ShortcutTable />
      </DialogContent>
    </Dialog>
  );
}

/** `/help`: where the guides are, how to reach support, the keys, the legal links. */
export function HelpPage() {
  return (
    <Box sx={{ maxWidth: 640, padding: 5, display: "flex", flexDirection: "column", gap: 6 }}>
      <Box
        component="section"
        sx={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}
      >
        <Typography sx={{ color: hf.textSecondary }}>{t("help.body")}</Typography>
        <Button component="a" href={EXTERNAL_LINKS.help} target="_blank" rel="noopener">
          {t("help.open")}
        </Button>
      </Box>
      <Box
        component="section"
        sx={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}
      >
        <Typography variant="h2">{t("help.contact")}</Typography>
        <Typography sx={{ color: hf.textSecondary }}>{t("help.contact.body")}</Typography>
        <Button component="a" href={EXTERNAL_LINKS.support} target="_blank" rel="noopener">
          {t("help.contact")}
        </Button>
      </Box>
      <Box component="section" sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <Typography variant="h2">{t("shortcuts.title")}</Typography>
        <ShortcutTable />
      </Box>
      <Box component="section">
        <Typography variant="h2">{t("help.legal")}</Typography>
        <Box sx={{ display: "flex", justifyContent: "flex-start", marginLeft: -4 }}>
          <LegalFooter />
        </Box>
      </Box>
    </Box>
  );
}
