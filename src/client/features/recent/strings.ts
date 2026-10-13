import { defineMessages } from "../../lib/i18n";

export const messages = {
  "recent.list": "Recently opened files",
  "recent.group.today": "Today",
  "recent.group.yesterday": "Yesterday",
  "recent.group.week": "This week",
  "recent.group.earlier": "Earlier",
  "recent.empty.title": "Nothing opened yet",
  "recent.empty.body": "Files you open appear here, newest first.",
  "recent.error.title": "Couldn't load your recent files",
} as const;

export const t = defineMessages(messages);
