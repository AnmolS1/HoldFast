// Placeholder scan consumer: acknowledge everything, so nothing is retried or dead-lettered.
// The export keeps this shape when the file is replaced: `bg` is the run's BackgroundContext —
// use `bg.db`, never a second client.

import type { BackgroundContext } from "../services/request-context";

export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  void env;
  void ctx;
  void bg;
  batch.ackAll();
}
