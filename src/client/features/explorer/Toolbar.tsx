// The row above the list while nothing is selected: how many items, the order, and (desktop) the
// two ways to add something. The selection bar takes its place when one or more items are chosen.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  FolderPlus,
  FolderUp,
  Upload,
} from "lucide-react";
import { useId, useState } from "react";
import { Kbd } from "../../components/Kbd";
import { t as shellT } from "../../lib/i18n";
import { shortcutLabel } from "../../lib/shortcuts";
import type { ViewMode } from "../../lib/prefs";
import { hf } from "../../theme/tokens";
import type { SortDir, SortKey } from "./api";
import { sortOptions, sortSentence } from "./model";
import { t } from "./strings";

export interface ToolbarProps {
  /** Items loaded so far; `more` says the folder holds more than that. */
  count: number;
  more: boolean;
  /** Hidden while the listing is loading or failed. */
  showCount: boolean;
  sort: SortKey;
  dir: SortDir;
  onSort(sort: SortKey, dir: SortDir): void;
  /** px — the height of the selection bar that takes this row's place. */
  height: number;
  /** Mobile layout: no add buttons (the frame's New button has them), the view switch in the menu. */
  desktop: boolean;
  viewMode: ViewMode;
  onViewMode(mode: ViewMode): void;
  canAdd: boolean;
  onNewFolder(): void;
  onUpload(): void;
  /** The folder picker, for the same folder as `onUpload`. */
  onUploadFolder(): void;
}

const tick = (on: boolean) => (
  <Box
    component="span"
    aria-hidden="true"
    sx={{ display: "inline-flex", width: (theme) => theme.spacing(4), flex: "none" }}
  >
    {on ? <Check size={14} /> : null}
  </Box>
);

export function Toolbar(props: ToolbarProps) {
  const { count, more, showCount, sort, dir, onSort, height, desktop, viewMode, onViewMode, canAdd } = props;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const close = () => setAnchor(null);
  const [uploadAnchor, setUploadAnchor] = useState<HTMLElement | null>(null);
  const uploadMenuId = useId();
  const closeUpload = () => setUploadAnchor(null);
  const countText = more
    ? t("explorer.count.more", { count })
    : count === 1
      ? t("explorer.count.one")
      : t("explorer.count.many", { count });
  return (
    <Box
      data-explorer-toolbar
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        minHeight: height,
        boxSizing: "border-box",
        paddingX: desktop ? 5 : 3,
        flex: "none",
      }}
    >
      <Box
        component="span"
        className="num"
        data-item-count
        sx={{ color: hf.textSecondary, typography: "body2", marginRight: 2, whiteSpace: "nowrap" }}
      >
        {showCount ? countText : ""}
      </Box>
      <Box sx={{ flex: "1 1 auto" }} />
      {desktop && canAdd ? (
        <>
          <Button
            variant="text"
            onClick={props.onNewFolder}
            startIcon={<FolderPlus size={16} aria-hidden="true" />}
            data-new-folder
          >
            {t("explorer.action.newFolder")}
          </Button>
          {/* A split button: the main half uploads files as before, the arrow offers the folder too. */}
          <Box sx={{ display: "inline-flex", alignItems: "center" }} data-upload-split>
            <Button
              variant="text"
              onClick={props.onUpload}
              startIcon={<Upload size={16} aria-hidden="true" />}
              data-upload
              sx={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            >
              {t("explorer.action.upload")}
            </Button>
            <Button
              variant="text"
              aria-label={t("explorer.action.uploadMenu")}
              aria-haspopup="menu"
              aria-controls={uploadAnchor ? uploadMenuId : undefined}
              aria-expanded={uploadAnchor ? true : undefined}
              onClick={(event) => setUploadAnchor(event.currentTarget)}
              data-upload-menu
              sx={{ minWidth: 0, paddingX: 2, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </Button>
          </Box>
          <Menu
            id={uploadMenuId}
            anchorEl={uploadAnchor}
            open={Boolean(uploadAnchor)}
            onClose={closeUpload}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
            slotProps={{ list: { "aria-label": t("explorer.action.uploadMenu") } }}
          >
            {(
              [
                ["files", Upload, "explorer.action.upload", "upload", props.onUpload],
                ["folder", FolderUp, "explorer.action.uploadFolder", "uploadFolder", props.onUploadFolder],
              ] as const
            ).map(([kind, Icon, label, shortcut, run]) => (
              <MenuItem
                key={kind}
                data-upload-kind={kind}
                onClick={() => {
                  // The picker opens inside this click; the menu closes around it.
                  run();
                  closeUpload();
                }}
              >
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{ display: "inline-flex", color: hf.textSecondary }}
                >
                  <Icon size={16} />
                </Box>
                <Box component="span" sx={{ flex: "1 1 auto" }}>
                  {t(label)}
                </Box>
                <Kbd>{shortcutLabel(shortcut)}</Kbd>
              </MenuItem>
            ))}
          </Menu>
        </>
      ) : null}
      <Button
        variant="text"
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? true : undefined}
        aria-label={t("explorer.sort.button", { order: sortSentence(sort, dir) })}
        onClick={(event) => setAnchor(event.currentTarget)}
        startIcon={<ArrowUpDown size={16} aria-hidden="true" />}
        data-sort-button
      >
        {sortOptions().find((option) => option.key === sort)?.label}
        {dir === "asc" ? (
          <ArrowUp size={14} aria-hidden="true" />
        ) : (
          <ArrowDown size={14} aria-hidden="true" />
        )}
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ list: { "aria-label": t("explorer.sort.label") } }}
      >
        {sortOptions().map((option) => (
          <MenuItem
            key={option.key}
            role="menuitemradio"
            aria-checked={sort === option.key}
            data-sort={option.key}
            onClick={() => {
              close();
              onSort(option.key, dir);
            }}
          >
            {tick(sort === option.key)}
            {option.label}
          </MenuItem>
        ))}
        <Divider component="li" sx={{ my: 1 }} />
        {(["asc", "desc"] as const).map((direction) => (
          <MenuItem
            key={direction}
            role="menuitemradio"
            aria-checked={dir === direction}
            data-sort-dir={direction}
            onClick={() => {
              close();
              onSort(sort, direction);
            }}
          >
            {tick(dir === direction)}
            {t(direction === "asc" ? "explorer.sort.ascending" : "explorer.sort.descending")}
          </MenuItem>
        ))}
        {desktop
          ? null
          : [
              <Divider key="rule" component="li" sx={{ my: 1 }} />,
              ...(["list", "grid"] as const).map((mode) => (
                <MenuItem
                  key={mode}
                  role="menuitemradio"
                  aria-checked={viewMode === mode}
                  data-view-mode={mode}
                  onClick={() => {
                    close();
                    onViewMode(mode);
                  }}
                >
                  {tick(viewMode === mode)}
                  {shellT(mode === "list" ? "header.view.list" : "header.view.grid")}
                </MenuItem>
              )),
            ]}
      </Menu>
    </Box>
  );
}
