import type { LoadedItem, PreviewSource } from "../source";

/** What every renderer is given. */
export interface RendererProps {
  source: PreviewSource;
  item: LoadedItem;
  /** Start this file's preview afresh (a new view, with its own one re-mint): the error state's button. */
  onRetry?(): void;
}
