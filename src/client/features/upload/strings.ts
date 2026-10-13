// Every string the uploader shows or announces. The shell's catalogue (lib/en.ts) is not edited by
// a feature; `t` here is called exactly like the shell's.
import { defineMessages } from "../../lib/i18n";

export const messages = {
  // The /uploads page.
  "page.intro":
    "Drop files anywhere in Holdfast, paste them, or choose them here. Progress shows in the transfer bar.",
  "page.chooseFiles": "Choose files",
  "page.chooseFolder": "Choose a folder",
  "page.free": "{free} free of {quota}",
  "page.paused": "Uploads are paused right now.",
  "page.error.title": "Couldn't load uploads",
  "page.error.body": "Your files are fine. Try again in a moment.",

  // Entry points.
  "input.files": "Choose files to upload",
  "input.folder": "Choose a folder to upload",
  "drop.to": "Drop to upload to {folder}",
  "drop.root": "Files",
  "drop.thisFolder": "this folder",

  // Before anything starts.
  "preflight.quota": "This needs {needed} and you have {free} free",
  "preflight.tooLarge": "This file is larger than the {max} limit.",
  "preflight.noName": "This file has no name.",

  // The ribbon's one sentence.
  "ribbon.uploading": "Uploading {n} of {total} · {left} left",
  "ribbon.uploadingEta": "Uploading {n} of {total} · {left} left · ~{eta}",
  "ribbon.verifying": "Verifying {n} of {total}…",
  "ribbon.scanning.one": "Scanning 1 file",
  "ribbon.scanning.other": "Scanning {count} files",
  "ribbon.paused": "Paused · {n} of {total} · {left} left",
  "ribbon.offline": "Offline — uploads resume when you're back online",
  "ribbon.auth": "Sign in to continue uploading",
  "ribbon.ceiling": "Daily upload limit reached — resumes after midnight UTC",
  "ribbon.disabled": "Uploads are paused right now.",
  "ribbon.conflict": "{name} already exists — choose what to do",
  "ribbon.resume.one": "1 upload to resume — select the file again",
  "ribbon.resume.other": "{count} uploads to resume — select the files again",
  "ribbon.failed.one": "1 upload didn't finish",
  "ribbon.failed.other": "{count} uploads didn't finish",
  "ribbon.refused.one": "1 file was refused",
  "ribbon.refused.other": "{count} files were refused",
  "ribbon.blocked.one": "1 file was blocked",
  "ribbon.blocked.other": "{count} files were blocked",
  "ribbon.unscanned.one": "Couldn't scan 1 file",
  "ribbon.unscanned.other": "Couldn't scan {count} files",
  "ribbon.done.one": "1 upload complete",
  "ribbon.done.other": "{count} uploads complete",
  "eta.seconds": "{n} s",
  "eta.minutes": "{n} min",
  "eta.hours": "{n} h",

  // The panel.
  "panel.title": "Uploads",
  "panel.pauseAll": "Pause all",
  "panel.resumeAll": "Resume all",
  "panel.in": "in {folder}",
  "row.waiting": "Waiting",
  "row.waitingFolder": "Waiting for its folder",
  "row.uploading": "{sent} of {size}",
  "row.uploadingSpeed": "{sent} of {size} · {speed}/s",
  "row.verifying": "Verifying…",
  "row.finishing": "Finishing…",
  "row.scanning": "Scanning",
  "row.done": "Uploaded",
  "row.cancelled": "Cancelled",
  "row.paused": "Paused",
  "row.offline": "Offline — resumes when you're back online",
  "row.auth": "Sign in to continue",
  "row.ceiling": "Daily upload limit reached — resumes after midnight UTC",
  "row.disabled": "Uploads are paused right now.",
  "row.selectAgain": "Select {name} again to resume",
  "row.conflict": "A file with this name is already here",
  "row.failed": "Didn't finish. Try again.",
  "row.unreadable": "Couldn't read this file. It may have been moved or changed.",
  "row.refused": "Refused — this file can't be stored here.",
  "row.ownerFull": "The owner's storage is full.",
  "action.pause": "Pause {name}",
  "action.resume": "Resume {name}",
  "action.cancel": "Cancel {name}",
  "action.retry": "Try {name} again",
  "action.remove": "Remove {name} from the list",
  "action.select": "Select file",
  "action.selectNamed": "Select {name} again",

  // Folder upload.
  "folder.taken":
    "Couldn't create the folder {name} — something else already has that name. Nothing in it was uploaded.",
  "folder.failed": "Couldn't create the folder {name}. Nothing in it was uploaded.",

  // The conflict dialog.
  "conflict.title": "{name} is already here",
  "conflict.body": "Replace the file that is here, keep both, or skip this one.",
  "conflict.bodyNoReplace": "Keep both files, or skip this one.",
  "conflict.replace": "Replace",
  "conflict.keepBoth": "Keep both",
  "conflict.skip": "Skip",
  "conflict.all": "Do the same for every other file that is already here",

  // The live region.
  "live.start": "Uploading {name}",
  "live.done": "{name} uploaded",
  "live.failed": "{name} didn't finish",
  "live.refused": "{name} was refused. This file can't be stored here.",
  "live.blocked": "{name} was blocked — flagged by the malware scan",
  "live.unscanned": "Couldn't scan {name}",
  "live.cancelled": "Cancelled {name}",
  "live.conflict": "{name} is already here",
  "live.label": "Upload updates",
} as const;

export const t = defineMessages(messages);
export type UploadMessageKey = keyof typeof messages;
