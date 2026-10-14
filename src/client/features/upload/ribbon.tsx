// Feeds the shell's transfer ribbon: the queue's fraction, sentence and status under the source
// id "upload", and the expanded panel's rows. The ribbon itself is the shell's; there is no
// second surface.
import { publish, setPanel, type RibbonState } from "../../components/TransferRibbon";
import { getUploads, subscribeUploads } from "./store";
import { summarise } from "./summary";
import { UploadPanel } from "./UploadPanel";

export const RIBBON_SOURCE = "upload";

let shown: RibbonState | null = null;
let panelShown = false;

function sync(): void {
  const snapshot = getUploads();
  const next = summarise(snapshot);
  const same =
    next === shown ||
    (next !== null &&
      shown !== null &&
      next.progress === shown.progress &&
      next.sentence === shown.sentence &&
      next.status === shown.status);
  if (!same) {
    shown = next;
    publish(RIBBON_SOURCE, next);
  }
  const wantsPanel = snapshot.items.length > 0;
  if (wantsPanel !== panelShown) {
    panelShown = wantsPanel;
    setPanel(RIBBON_SOURCE, wantsPanel ? <UploadPanel /> : null);
  }
}

subscribeUploads(sync);

/** Tests only: the ribbon store was reset underneath, so forget what was published. */
export function resetRibbonFeedForTests(): void {
  shown = null;
  panelShown = false;
}
