// Handing a file to the browser: a hidden `<a download>`, clicked once and removed. The URL is a
// short-lived bearer token (or an object URL): it is never stored or logged.

function clickLink(href: string, fileName?: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName ?? "";
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Start the download of a minted files-host URL (its `Content-Disposition` names the file). */
export function saveUrl(url: string): void {
  clickLink(url);
}

/** Save bytes built in the page under the given name. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  clickLink(url, fileName);
  // The download has been handed over by the click; the object can go once the browser took it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
