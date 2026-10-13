import type { ReactNode } from "react";
import type { LoadedItem, PreviewSource } from "../source";

/** What every renderer is given. */
export interface RendererProps {
  source: PreviewSource;
  item: LoadedItem;
  /** The Download button, when this viewer may download the file; shown beside a failure. */
  download?: ReactNode;
}
