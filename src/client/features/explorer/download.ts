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

function clickLink(href: string, attributes: { download?: string; target?: string }): void {
  const link = document.createElement("a");
  link.href = href;
  if (attributes.download !== undefined) link.download = attributes.download;
  if (attributes.target) link.target = attributes.target;
  link.rel = "noopener noreferrer";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Start the download of a minted files-host URL (its `Content-Disposition` names the file).
 * In a tab of its own: when the files host answers with an error instead of an attachment, that
 * page shows there — the app, its uploads and its zips stay where they are, and the token never
 * enters this tab's history. False when the URL was refused.
 */
export function saveUrl(url: string): boolean {
  if (!isFilesUrl(url)) return false;
  clickLink(url, { target: "_blank" });
  return true;
}

/** Save bytes built in the page under the given name. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  clickLink(url, { download: fileName });
  // The download has been handed over by the click; the object can go once the browser took it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
