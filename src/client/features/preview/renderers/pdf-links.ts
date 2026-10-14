// What a link inside a PDF may point the browser at.

/** Only these leave the app from a document; everything else (`javascript:`, `file:`, …) is dropped. */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
