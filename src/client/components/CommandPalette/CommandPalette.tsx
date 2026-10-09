import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import { Command as Cmdk } from "cmdk";
import { Search } from "lucide-react";
import { useState } from "react";
import { t, type MessageKey } from "../../lib/i18n";
import { shortcutLabel } from "../../lib/shortcuts";
import { hf, layout } from "../../theme/tokens";
import { Kbd } from "../Kbd";
import { closePalette, useCommands, usePaletteOpen, type Command, type CommandSection } from "./registry";

// Selection-aware commands come first, then navigation, then actions.
const SECTIONS: Array<{ id: CommandSection; heading: MessageKey }> = [
  { id: "selection", heading: "palette.section.selection" },
  { id: "goto", heading: "palette.section.goto" },
  { id: "actions", heading: "palette.section.actions" },
];

const listSx = {
  padding: 2,
  maxHeight: 420,
  overflowY: "auto",
  "& [cmdk-group-heading]": { padding: "8px 10px 4px", fontSize: 12, lineHeight: "16px", color: hf.textSecondary },
  "& [cmdk-item]": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minHeight: "var(--hf-row-h)",
    padding: "0 10px",
    borderRadius: `${layout.radius.control}px`,
    cursor: "default",
    userSelect: "none",
  },
  "& [cmdk-item][data-disabled='true']": { color: hf.textSecondary },
  "& [cmdk-empty]": { padding: "24px 10px", textAlign: "center", color: hf.textSecondary },
} as const;

function Row({ command }: { command: Command }) {
  return (
    <Cmdk.Item
      value={[command.label, ...(command.keywords ?? [])].join(" ")}
      disabled={command.disabled}
      data-command-id={command.id}
      onSelect={() => {
        closePalette();
        command.run();
      }}
    >
      {command.icon ? (
        <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary, flex: "none" }}>
          {command.icon}
        </Box>
      ) : null}
      <Box component="span" sx={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {command.label}
      </Box>
      {command.hint ? (
        <Box component="span" sx={{ color: hf.textSecondary, fontSize: 12, flex: "none" }}>
          {command.hint}
        </Box>
      ) : null}
      {command.shortcut ? <Kbd>{shortcutLabel(command.shortcut)}</Kbd> : null}
    </Cmdk.Item>
  );
}

/**
 * The second navigation. A cmdk list inside a modal dialog; the highlighted row is styled by the
 * theme's selection rule (the list is a `data-hf-list` container). The footer teaches the keys.
 */
export function CommandPalette() {
  const open = usePaletteOpen();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  return (
    <Dialog
      open={open}
      onClose={closePalette}
      fullWidth
      maxWidth={false}
      aria-label={t("palette.label")}
      slotProps={{
        paper: { sx: { maxWidth: 640, overflow: "hidden", alignSelf: "flex-start", marginTop: { xs: 4, md: 24 } } },
        transition: { onExited: () => setQuery("") },
      }}
    >
      <Cmdk label={t("palette.label")} loop>
        <Box sx={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 16px", borderBottom: `1px solid ${hf.hairline}` }}>
          <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
            <Search size={16} />
          </Box>
          <Box
            component={Cmdk.Input}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("palette.placeholder")}
            sx={{ flex: "1 1 auto", minWidth: 0, height: 32, border: 0, outline: "none", background: "transparent", color: hf.text, font: "inherit", fontSize: { xs: 16, md: 15 }, "&::placeholder": { color: hf.textSecondary } }}
          />
          <Kbd>{shortcutLabel("escape")}</Kbd>
        </Box>
        <Box component={Cmdk.List} data-hf-list sx={listSx}>
          <Cmdk.Empty>{t("palette.empty")}</Cmdk.Empty>
          {SECTIONS.map((section) => {
            const rows = commands.filter((command) => command.section === section.id);
            if (rows.length === 0) return null;
            return (
              <Cmdk.Group key={section.id} heading={t(section.heading)}>
                {rows.map((command) => (
                  <Row key={command.id} command={command} />
                ))}
              </Cmdk.Group>
            );
          })}
        </Box>
      </Cmdk>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", padding: "8px 16px", borderTop: `1px solid ${hf.hairline}`, backgroundColor: hf.bg, color: hf.textSecondary, fontSize: 12 }}>
        <span>
          <Kbd>↑↓</Kbd> {t("palette.footer.move")}
        </span>
        <span>
          <Kbd>↵</Kbd> {t("palette.footer.run")}
        </span>
        <span>
          <Kbd>{shortcutLabel("palette")}</Kbd> {t("palette.footer.toggle")}
        </span>
        <Box sx={{ flex: "1 1 auto" }} />
        <span>
          {t("palette.footer.shortcuts")} <Kbd>?</Kbd>
        </span>
      </Box>
    </Dialog>
  );
}
