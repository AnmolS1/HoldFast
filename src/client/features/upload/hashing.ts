// The page's side of the hashing worker: one worker per file, started when the upload starts and
// stopped when the digest is in or the upload is cancelled.
import type { HashReply, HashRequest } from "../../workers/sha256.worker";

export interface HashJob {
  /** The SHA-256 as 64 lower-case hex characters. Rejects when the file cannot be read. */
  promise: Promise<string>;
  /** Stop the worker; the promise then never settles. */
  cancel(): void;
}

export type StartHash = (file: Blob) => HashJob;

export const startHashInWorker: StartHash = (file) => {
  const worker = new Worker(new URL("../../workers/sha256.worker.ts", import.meta.url), { type: "module" });
  const promise = new Promise<string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<HashReply>) => {
      const reply = event.data;
      if (reply.type === "progress") return;
      worker.terminate();
      if (reply.type === "done") resolve(reply.sha256);
      else reject(new Error(reply.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
  });
  const request: HashRequest = { file };
  worker.postMessage(request);
  return { promise, cancel: () => worker.terminate() };
};
