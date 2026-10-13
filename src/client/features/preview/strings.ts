// Every string the preview shows. The shell's catalogue (`lib/en.ts`) is not edited.
import { defineMessages } from "../../lib/i18n";

export const messages = {
  "preview.loading": "Loading preview",
  "preview.previous": "Previous file",
  "preview.next": "Next file",
  "preview.position": "{index} of {count}",
  "preview.download": "Download",
  "preview.share": "Share",
  "preview.close": "Close preview",
  "preview.unscanned": "This file couldn't be scanned. Download it only if you trust where it came from.",

  "type.image": "Image",
  "type.video": "Video",
  "type.audio": "Audio",
  "type.pdf": "PDF",
  "type.document": "Document",
  "type.archive": "Archive",
  "type.code": "Code",
  "type.other": "File",
  "type.withExt": "{ext} · {type}",

  "scan.pending": "Scanning…",
  "scan.pending.label": "Scanning {name}",
  "scan.pending.body": "The preview opens by itself when the scan finishes.",

  "none.title": "No preview for this type",
  "none.typeDownload": "No preview for this type — download to open it",
  "none.blocked": "This file can't be previewed or downloaded.",
  "none.tooLarge": "Too large to preview — download",
  "none.heicUnavailable": "No preview for this photo — download to see it",

  "error.title": "Couldn't open this preview",
  "error.body": "The file is fine. Close the preview and try again.",
  "error.notFound.title": "This file isn't here",
  "error.notFound.body": "It may have been moved or deleted, or you may not have access to it.",
  "error.retry": "Try again",

  "image.fit": "Fit",
  "image.actual": "1:1",
  "image.zoomIn": "Zoom in",
  "image.zoomOut": "Zoom out",
  "image.zoom": "Zoom",
  "image.heic": "Original is HEIC — download for full quality",

  "pdf.page": "Page",
  "pdf.pageOf": "of {count}",
  "pdf.pageLabel": "Page {page}",
  "pdf.previousPage": "Previous page",
  "pdf.nextPage": "Next page",
  "pdf.zoomIn": "Zoom in",
  "pdf.zoomOut": "Zoom out",
  "pdf.fitWidth": "Fit width",
  "pdf.capped": "Showing the first {shown} of {count} pages. Download the file for the rest.",
  "pdf.leave.title": "You're leaving Holdfast",
  "pdf.leave.body": "This link in the document opens another site:",
  "pdf.leave.confirm": "Open link",
  "pdf.locked": "This PDF is password-protected — download to open it",

  "text.wrap": "Wrap lines",
  "text.capped": "Showing the first {shown} of {count} lines. Download the file for the rest.",
  "text.label": "Contents of {name}",

  "media.unsupported": "Your browser can't play this — download",
  "media.video": "Video: {name}",
  "media.audio": "Audio: {name}",
} as const;

export const t = defineMessages(messages);
