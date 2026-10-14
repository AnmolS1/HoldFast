import { defineMessages } from "../../lib/i18n";

export const messages = {
  "usage.free": "{free} free",
  "usage.over": "{over} over the limit",
  "usage.breakdown": "What uses your storage",
  "usage.files": "Files",
  "usage.trash": "Trash",
  "usage.versions": "Previous versions",
  "usage.reserved": "Uploads in progress",
  "usage.note":
    "Items in the trash and earlier versions of replaced files count toward your storage until they're deleted for good.",
  "usage.openTrash": "Open the trash",
  "usage.error.title": "Couldn't load your storage use",
} as const;

export const t = defineMessages(messages);
