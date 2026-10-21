import { defineMessages } from "../../lib/i18n";

export const messages = {
  "danger.title": "Download {name}?",
  "danger.program": "Programs like this one can install software and change anything on your device.",
  "danger.script": "Scripts like this one can run commands on your device as soon as they are opened.",
  "danger.image": "Disk images like this one can hold programs that run when the image is opened.",
  "danger.settings": "Files like this one can change your device's settings or start other programs.",
  "danger.other": "Files of this type can run programs on your device.",
  "danger.trust": "Only open it if you trust whoever shared it with you.",
  "danger.continue": "Download anyway",
  "danger.cancel": "Cancel",
} as const;

export const t = defineMessages(messages);
