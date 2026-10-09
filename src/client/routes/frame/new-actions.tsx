import { FolderPlus, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { COMMAND_IDS, runCommand, useCommand } from "../../components/CommandPalette";
import { requestUpload } from "../../features/upload";
import { t } from "../../lib/i18n";
import { usePublicConfig } from "../../lib/query";
import { shortcutLabel } from "../../lib/shortcuts";

export interface NewAction {
  id: "new-folder" | "upload";
  label: string;
  icon: ReactNode;
  shortcut: string;
  disabled: boolean;
  reason?: string;
  run(): void;
}

/** New folder and Upload, with the reasons they may be unavailable. Shared by the menu and the FAB. */
export function useNewActions(): NewAction[] {
  const config = usePublicConfig().data;
  const newFolder = useCommand(COMMAND_IDS.newFolder);
  const readOnly = Boolean(config?.readOnly);
  const uploadsOff = config ? !config.uploadsEnabled : false;
  return [
    {
      id: "new-folder",
      label: t("header.newFolder"),
      icon: <FolderPlus size={16} />,
      shortcut: shortcutLabel("newFolder"),
      // The explorer registers the command; until it has, there is nothing to run.
      disabled: readOnly || !newFolder || Boolean(newFolder.disabled),
      reason: readOnly ? t("header.readOnlyDisabled") : undefined,
      run: () => void runCommand(COMMAND_IDS.newFolder),
    },
    {
      id: "upload",
      label: t("header.upload"),
      icon: <Upload size={16} />,
      shortcut: shortcutLabel("upload"),
      disabled: readOnly || uploadsOff,
      reason: readOnly ? t("header.readOnlyDisabled") : uploadsOff ? t("header.uploadsDisabled") : undefined,
      run: () => requestUpload(),
    },
  ];
}
