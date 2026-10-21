// The sharing feature's public face: the Shared-with-me route, the `ShareDialog` slot (T08's
// props), and what Shared by me builds its link rows from.
export { routes } from "./routes";
export { ShareDialog } from "./ShareDialog";
export { LinkRow } from "./ShareDialog";
export {
  forThisAccount,
  patchLink,
  patchShare,
  refreshSharing,
  removeShare,
  revokeLink,
  useLinksMine,
  useSharesMine,
} from "./api";
export { copyText, countWords, pauseAction, pausedLines, stateWords } from "./link-words";
