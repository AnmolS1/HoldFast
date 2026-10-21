import { defineMessages } from "../../lib/i18n";

export const messages = {
  "public.title": "Shared file",
  "public.loading": "Opening the link…",
  "public.brand": "Holdfast",

  // What the page says when the link does not answer — and never more than this.
  "public.state.gone": "This link is no longer available.",
  "public.state.limit": "This link has reached its download limit.",
  "public.state.traffic": "This link is temporarily unavailable due to high traffic.",
  "public.state.unavailable": "This link is temporarily unavailable.",
  "public.state.error": "Couldn't open this link. Try again in a moment.",
  "public.retry": "Try again",

  // The password
  "public.password.title": "This link is protected",
  "public.password.body": "Enter the password the person who shared it gave you.",
  "public.password.label": "Password",
  "public.password.submit": "Open",
  "public.password.checking": "Checking…",
  "public.password.wrong": "That password isn't right.",
  "public.password.wait": "Too many tries. Try again in {seconds} s.",
  "public.password.waitMinutes": "Too many tries. Try again in {minutes} min.",

  // The file
  "public.file.clean": "Scanned for viruses — nothing found.",
  "public.file.download": "Download",
  "public.file.downloading": "Getting the download…",
  "public.file.preview": "Preview",
  "public.file.tomorrow": "This link has reached today's download limit. Try again tomorrow.",
  "public.file.busy": "Too many requests just now. Try again in a minute.",
  "public.file.limit": "This link has reached its download limit.",
  "public.file.failed": "Couldn't start the download. Try again.",

  // The folder
  "public.folder.list": "Files in {name}",
  "public.folder.empty": "This folder is empty.",
  "public.folder.more": "Show more",
  "public.folder.up": "Back to {name}",
  "public.folder.open": "Open {name}",
  "public.folder.downloadFile": "Download {name}",
  "public.folder.previewFile": "Preview {name}",
  "public.zip.download": "Download all as zip",
  "public.zip.working": "Making the zip… {done} of {total}",
  "public.zip.cancel": "Cancel",
  "public.zip.saved": "Zip saved.",
  "public.zip.partial": "Zip saved without {count} files that could not be fetched.",
  "public.zip.empty": "There is nothing in this folder to download.",
  "public.zip.tooLarge": "This folder is too large to zip here. Download the files one by one.",
  "public.zip.unavailable": "{count} files are not available and are left out.",
  "public.zip.unavailable.one": "1 file is not available and is left out.",
  "public.zip.failed": "Couldn't make the zip. Try again.",
  "public.zip.cancelled": "Zip cancelled.",

  "public.openInApp": "Open in Holdfast",
} as const;

export const t = defineMessages(messages);
