import { defineMessages } from "../../lib/i18n";

export const messages = {
  "byMe.tabs": "Shared by me",
  "byMe.tab.people": "People",
  "byMe.tab.links": "Links",
  "byMe.people.empty.title": "You haven't shared anything with people",
  "byMe.people.empty.body": "Share a file or folder from its menu, and it appears here.",
  "byMe.people.list": "Shared with people, by item",
  "byMe.people.role": "Role for {email}",
  "byMe.people.remove": "Remove {email}",
  "byMe.role.viewer": "Can view",
  "byMe.role.editor": "Can edit",
  "byMe.people.removed": "{email} no longer has access",
  "byMe.links.empty.title": "You haven't created any links",
  "byMe.links.empty.body": "Create a link from an item's share dialog, and it appears here.",
  "byMe.links.list": "Your links",
  "byMe.links.filter": "Show",
  "byMe.links.filter.all": "All links",
  "byMe.links.filter.limited": "Limit reached today",
  "byMe.links.select": "Select the link to {name}",
  "byMe.links.selectAll": "Select every link shown",
  "byMe.links.revokeSelected.one": "Revoke 1 link",
  "byMe.links.revokeSelected": "Revoke {count} links",
  "byMe.links.revokeAll.title.one": "Revoke 1 link?",
  "byMe.links.revokeAll.title": "Revoke {count} links?",
  "byMe.links.revokeAll.consequence":
    "Anyone who has these links loses access, now and for good. This can't be undone.",
  "byMe.links.revokeAll.done.one": "1 link revoked",
  "byMe.links.revokeAll.done": "{count} links revoked",
  "byMe.links.revokeAll.partial": "{done} revoked, {left} could not be. Try again.",
  "byMe.error.title": "Couldn't load what you've shared",
  "byMe.retry": "Try again",
} as const;

export const t = defineMessages(messages);
