// Copy of the Starred view, and of the pieces the five view features share (the page error state).
import { defineMessages } from "../../lib/i18n";

export const messages = {
  "view.error.body": "Try again in a moment. If it keeps happening, contact support with the request id.",
  "view.error.retry": "Try again",
  "starred.list": "Starred files and folders",
  "starred.empty.title": "Nothing starred",
  "starred.empty.body": "Star a file or folder to keep it one step away.",
  "starred.error.title": "Couldn't load your starred items",
} as const;

export const t = defineMessages(messages);
