import { defineMessages } from "../../lib/i18n";

export const messages = {
  "search.input": "Search files and folders",
  "search.results": "Search results",
  "search.count": "{count} results",
  "search.count.one": "1 result",
  "search.count.more": "More than {count} results",
  "search.type": "Type",
  "search.type.any": "Any type",
  "search.type.image": "Images",
  "search.type.video": "Videos",
  "search.type.audio": "Audio",
  "search.type.pdf": "PDFs",
  "search.type.document": "Documents",
  "search.type.archive": "Archives",
  "search.type.code": "Code",
  "search.type.other": "Other",
  "search.scope": "Search in",
  "search.scope.all": "All",
  "search.scope.mine": "My files",
  "search.scope.shared": "Shared with me",
  "search.filters": "Filters",
  "search.prompt.title": "Search your files",
  "search.prompt.body": "Type two or more letters of a name. Small typos are fine.",
  "search.none.title": "No files match",
  "search.none.body": "Try fewer words, another type, or search everything you have access to.",
  "search.error.title": "Couldn't run this search",
  "search.suggestions": "Suggestions",
} as const;

export const t = defineMessages(messages);
