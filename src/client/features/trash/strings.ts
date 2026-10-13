import { defineMessages } from "../../lib/i18n";

export const messages = {
  "trash.list": "Items in the trash",
  "trash.note":
    "Items stay here until the date shown, then they're deleted forever. Restore an item to open it.",
  "trash.count": "{count} items",
  "trash.count.one": "1 item",
  "trash.count.more": "More than {count} items",
  "trash.secondary": "Deleted {deleted} · Deleted forever on {purge}",
  "trash.empty.title": "Trash is empty",
  "trash.empty.body": "Items you move to the trash appear here.",
  "trash.error.title": "Couldn't load the trash",
  "trash.openHint": "Restore this item to open it.",
  "trash.restore": "Restore",
  "trash.restored": "{name} restored",
  "trash.restore.conflict": "Restore the folder this was in first",
  "trash.dismiss": "Dismiss",
  "trash.deleteForever": "Delete forever",
  "trash.delete.title.one": "Delete {name} forever?",
  "trash.delete.title": "Delete {count} items forever?",
  "trash.delete.consequence.one": "This can't be undone. 1 item.",
  "trash.delete.consequence": "This can't be undone. {count} items.",
  "trash.delete.folders": "Folders are deleted with everything in them.",
  "trash.delete.done.one": "{name} deleted forever",
  "trash.delete.done": "{count} items deleted forever",
  "trash.emptyTrash": "Empty trash",
  "trash.emptyTrash.title": "Empty the trash?",
  "trash.emptyTrash.more": "This can't be undone. More than {count} items.",
  "trash.emptyTrash.everything": "This can't be undone. Everything in the trash is deleted.",
  "trash.emptyTrash.type": "Type {word} to confirm",
  "trash.emptyTrash.starting": "Deleting…",
  "trash.emptyTrash.progress": "Deleting… {remaining} left",
  "trash.emptyTrash.done": "Trash emptied",
  "trash.emptyTrash.stopped": "Couldn't finish emptying the trash. Try again.",
  "trash.emptyTrash.stoppedLeft": "Couldn't finish emptying the trash. {remaining} left. Try again.",
} as const;

export const t = defineMessages(messages);
