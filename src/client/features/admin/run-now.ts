// "Run now": one bounded pass per call of `POST /api/admin/jobs/:name/run`, repeated while the
// answer is `202 { done: false }` — and NEVER on anything else: `200 { done: true }` ends it, a
// `409` (the rollback detector or the pause switch stopped a guarded job) ends it and the System
// screen shows the detector panel, any error ends it, and so does an account change (the purger
// below aborts every loop; a loop also checks the epoch before each call — no call is ever made
// for an identity that did not start it).
import { registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, sameAccount } from "../../lib/query";
import { runJobPass } from "./api";
import { reasonOf } from "./words";

export type LoopOutcome =
  | { kind: "done"; passes: number }
  | { kind: "stopped"; reason: "rolled_back" | "destroy_paused"; passes: number }
  | { kind: "error"; error: unknown; passes: number }
  | { kind: "aborted"; passes: number };

const active = new Set<AbortController>();

registerUserStatePurger(() => {
  for (const controller of active) controller.abort();
  active.clear();
});

export async function runUntilDone(name: string, onPass: (passes: number) => void): Promise<LoopOutcome> {
  const then = accountEpoch();
  const controller = new AbortController();
  active.add(controller);
  let passes = 0;
  try {
    for (;;) {
      if (controller.signal.aborted || !sameAccount(then)) return { kind: "aborted", passes };
      let done: boolean;
      try {
        done = (await runJobPass(name)).done;
      } catch (error) {
        passes += 1;
        const reason = reasonOf(error);
        if (reason === "rolled_back" || reason === "destroy_paused")
          return { kind: "stopped", reason, passes };
        return { kind: "error", error, passes };
      }
      passes += 1;
      if (controller.signal.aborted || !sameAccount(then)) return { kind: "aborted", passes };
      onPass(passes);
      if (done) return { kind: "done", passes };
    }
  } finally {
    active.delete(controller);
  }
}
