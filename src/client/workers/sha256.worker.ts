/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// Streaming SHA-256 of a file, off the main thread. The file is read in slices, so memory stays at
// one slice however large the file is. This is the only module that imports the WASM hasher: the
// page reaches it through `new Worker(new URL(…))` and never imports it.
import { createSHA256 } from "hash-wasm";

/** 8 MiB. */
export const HASH_SLICE_BYTES = 8 * 1024 * 1024;

export interface HashRequest {
  file: Blob;
}

export type HashReply =
  | { type: "progress"; hashed: number }
  | { type: "done"; sha256: string }
  | { type: "error"; message: string };

/** The digest as 64 lower-case hex characters. `onProgress` gets the bytes hashed so far. */
export async function digestBlob(
  blob: Blob,
  onProgress?: (hashed: number) => void,
  sliceBytes: number = HASH_SLICE_BYTES,
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < blob.size; offset += sliceBytes) {
    const end = Math.min(blob.size, offset + sliceBytes);
    hasher.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    onProgress?.(end);
  }
  return hasher.digest("hex");
}

// A worker has no document; a test that imports this module for `digestBlob` does.
if (typeof document === "undefined") {
  self.onmessage = (event: MessageEvent<HashRequest>) => {
    const post = (reply: HashReply) => self.postMessage(reply);
    digestBlob(event.data.file, (hashed) => post({ type: "progress", hashed })).then(
      (sha256) => post({ type: "done", sha256 }),
      (cause: unknown) => post({ type: "error", message: cause instanceof Error ? cause.message : "" }),
    );
  };
}
