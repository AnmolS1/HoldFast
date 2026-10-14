// Handing a file to the browser. A minted URL is a short-lived bearer token: it is never stored or
// logged, and it is followed only when it leads where downloads are served.
import { publicConfigQuery, queryClient } from "../../lib/query";

/**
 * Whether a URL the API answered may be followed: http(s), and on the files origin of the public
 * config. Anything else — another scheme, another host — is refused, whatever the API said.
 */
export function isFilesUrl(url: string): boolean {
  const filesOrigin = queryClient.getQueryData(publicConfigQuery.queryKey)?.filesOrigin;
  if (!filesOrigin) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin === new URL(filesOrigin).origin
    );
  } catch {
    return false;
  }
}

function clickLink(href: string, download: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = download;
  link.rel = "noopener noreferrer";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

export type DownloadOpened = "opened" | "refused" | "blocked";

/** The tab one download will be shown in, opened before its URL is known. */
export interface DownloadTab {
  /** Point the tab at a minted files-host URL; a refused URL closes it instead. */
  go(url: string): DownloadOpened;
  /** Nothing to download after all: the tab goes again. */
  close(): void;
}

/**
 * A tab of its own for one download (its `Content-Disposition` names the file): when the files
 * host answers with an error instead of an attachment, that page shows there — the app, its
 * uploads and its zips stay where they are, and the token never enters this tab's history.
 *
 * It is opened in the click itself, before the URL is asked for: a tab opened after an awaited
 * request is outside the click's activation and a browser may block it as a pop-up (Safari,
 * Firefox). Opened empty and cut from this page (`opener = null`); the page's own referrer policy
 * (strict-origin-when-cross-origin) lets the files host see the app's origin at most.
 */
export function openDownloadTab(): DownloadTab {
  let tab: Window | null = null;
  try {
    tab = window.open("", "_blank");
  } catch {
    tab = null;
  }
  if (tab) tab.opener = null;
  return {
    go(url) {
      if (!isFilesUrl(url)) {
        tab?.close();
        return "refused";
      }
      // Refused by the browser at the click, or closed by the user meanwhile.
      if (!tab || tab.closed) return "blocked";
      tab.location.replace(url);
      return "opened";
    },
    close() {
      tab?.close();
    },
  };
}

/** Save bytes built in the page under the given name. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  clickLink(url, fileName);
  // The download has been handed over by the click; the object can go once the browser took it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
