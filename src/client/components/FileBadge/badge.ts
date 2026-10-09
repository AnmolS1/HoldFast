import type { MimeCategory } from "../types";

const CATEGORY_BADGE: Record<MimeCategory, string> = {
  image: "IMG",
  video: "VID",
  audio: "AUD",
  pdf: "PDF",
  document: "DOC",
  archive: "ZIP",
  code: "</>",
  other: "",
};

/** The 2–3 letter badge: the extension when it is short, else the category's. */
export function badgeText(name: string, category: MimeCategory): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (/^[A-Za-z0-9]{2,3}$/.test(ext)) return ext.toUpperCase();
  return CATEGORY_BADGE[category];
}
