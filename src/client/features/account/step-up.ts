// The step-up's shared parts: where its wait is held, and the hook the screens call.
import { createContext, useContext } from "react";
import { waitKey } from "../../lib/query";
import { accountKeys } from "./api";
import type { AuthOutcome } from "./auth-calls";

/** Where the step-up's wait is held (lib/query.ts registry). */
export const STEP_UP_WAIT = waitKey(accountKeys.stepUp);

export type Run = <T>(action: () => Promise<AuthOutcome<T>>) => Promise<AuthOutcome<T>>;

export const StepUpContext = createContext<Run | null>(null);

/** `run(action)`: the action, and — on SECOND_FACTOR_REQUIRED — the prompt, then the action once more. */
export function useStepUp(): Run {
  const run = useContext(StepUpContext);
  if (!run) throw new Error("useStepUp outside StepUpProvider");
  return run;
}
