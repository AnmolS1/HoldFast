// Hands a file the page made (the export, the backup codes) to the browser's downloads.

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // After the click has been handled: the download holds its own reference.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function saveText(text: string, fileName: string): void {
  saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), fileName);
}
