// Copy of the Starred view, and of the pieces the five view features share (the page error state).
import { defineMessages } from "../../lib/i18n";

export const messages = {
  "view.error.body": "Try again in a moment. If it keeps happening, contact support with the request id.",
  "view.error.retry": "Try again",
  "view.retry.wait": "Too many requests just now. You can try again shortly.",
  "view.offline.title": "Can't reach Holdfast",
  "view.offline.body": "Check your connection. This page loads by itself once you're back online.",
  "view.more.failed": "Couldn't load more of this list.",
  "view.refresh.failed": "Couldn't refresh this list. It may be out of date.",
  "starred.list": "Starred files and folders",
  "starred.empty.title": "Nothing starred",
  "starred.empty.body": "Star a file or folder to keep it one step away.",
  "starred.error.title": "Couldn't load your starred items",
} as const;

export const t = defineMessages(messages);
