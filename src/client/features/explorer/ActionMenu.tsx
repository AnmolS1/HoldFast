// One list of actions, two containers: a menu at the pointer or the row's button on desktop, a
// bottom sheet on the mobile layout. Every entry that has a shortcut shows it.
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import ListItemButton from "@mui/material/ListItemButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import type { ReactNode } from "react";
import { BottomSheet } from "../../components/BottomSheet";
import { Kbd } from "../../components/Kbd";
import { shortcutLabel, type ShortcutId } from "../../lib/shortcuts";
import { hf, layout } from "../../theme/tokens";

export interface MenuEntry {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: ShortcutId;
  disabled?: boolean;
  /** Why a disabled entry is disabled, in a few words. */
  hint?: string;
  /** "Move to trash" is the one entry that takes the danger colour. */
  destructive?: boolean;
  /** A rule above this entry. */
  separated?: boolean;
  run(): void;
}

export type MenuAnchor = { x: number; y: number } | HTMLElement;

export interface ActionMenuProps {
  open: boolean;
  /** Names the menu: the item's name, or "3 items". */
  title: string;
  entries: MenuEntry[];
  anchor: MenuAnchor | null;
  /** Mobile layout: a sheet instead of a menu. */
  sheet: boolean;
  onClose(): void;
}

function Label({ entry }: { entry: MenuEntry }) {
  return (
    <Box component="span" sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 }}>
      {entry.label}
      {entry.hint ? (
        <Box component="span" sx={{ typography: "body2", color: hf.textSecondary }}>
          {entry.hint}
        </Box>
      ) : null}
    </Box>
  );
}

function Icon({ entry }: { entry: MenuEntry }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{ display: "inline-flex", flex: "none", color: entry.destructive ? hf.danger : hf.textSecondary }}
    >
      {entry.icon}
    </Box>
  );
}

export function ActionMenu({ open, title, entries, anchor, sheet, onClose }: ActionMenuProps) {
  const pick = (entry: MenuEntry) => {
    onClose();
    entry.run();
  };
  if (sheet) {
    return (
      <BottomSheet open={open} onClose={onClose} title={title}>
        <Box component="ul" data-action-sheet sx={{ listStyle: "none", margin: 0, padding: 0 }}>
          {entries.map((entry) => (
            <Box
              component="li"
              key={entry.id}
              sx={
                entry.separated
                  ? { borderTop: `1px solid ${hf.hairline}`, marginTop: 1, paddingTop: 1 }
                  : undefined
              }
            >
              <ListItemButton
                disabled={entry.disabled}
                data-action={entry.id}
                onClick={() => pick(entry)}
                sx={{
                  minHeight: layout.touchRowHeight,
                  typography: "body1",
                  color: entry.destructive ? hf.danger : "inherit",
                }}
              >
                <Icon entry={entry} />
                <Label entry={entry} />
              </ListItemButton>
            </Box>
          ))}
        </Box>
      </BottomSheet>
    );
  }
  const atPoint = anchor !== null && !(anchor instanceof HTMLElement);
  return (
    <Menu
      open={open && anchor !== null}
      onClose={onClose}
      anchorReference={atPoint ? "anchorPosition" : "anchorEl"}
      anchorPosition={atPoint ? { top: anchor.y, left: anchor.x } : undefined}
      anchorEl={atPoint ? undefined : anchor}
      slotProps={{ list: { "aria-label": title } }}
      data-action-menu
    >
      {entries.flatMap((entry) => [
        entry.separated ? <Divider key={`${entry.id}-rule`} component="li" sx={{ margin: "4px 0" }} /> : null,
        <MenuItem
          key={entry.id}
          disabled={entry.disabled}
          data-action={entry.id}
          onClick={() => pick(entry)}
          sx={{ color: entry.destructive ? hf.danger : "inherit" }}
        >
          <Icon entry={entry} />
          <Label entry={entry} />
          {entry.shortcut ? <Kbd>{shortcutLabel(entry.shortcut)}</Kbd> : null}
        </MenuItem>,
      ])}
    </Menu>
  );
}
