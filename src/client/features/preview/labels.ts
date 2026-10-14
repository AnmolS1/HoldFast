import type { PreviewItem } from "../../components/slots";
import type { MimeCategory } from "../../components/types";
import { messages, t } from "./strings";

const TYPE_KEY: Record<MimeCategory, keyof typeof messages> = {
  image: "type.image",
  video: "type.video",
  audio: "type.audio",
  pdf: "type.pdf",
  document: "type.document",
  archive: "type.archive",
  code: "type.code",
  other: "type.other",
};

/** "PNG · Image"; the category alone when the extension says nothing more ("PDF"). */
export function typeLabel(item: Pick<PreviewItem, "mimeCategory" | "ext">): string {
  const type = t(TYPE_KEY[item.mimeCategory]);
  const ext = item.ext.replace(/^\./, "").toUpperCase();
  if (!ext || ext.length > 8 || ext === type.toUpperCase()) return type;
  return t("type.withExt", { ext, type });
}
