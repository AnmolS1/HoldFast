import type { LoadedItem, PreviewSource } from "../source";

/** What every renderer is given. */
export interface RendererProps {
  source: PreviewSource;
  item: LoadedItem;
}
