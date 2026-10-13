// What `retryOnDeadlock` hands its callback is accepted as `{ tx }` by the services that insist
// on a real transaction. Type-level: the assertions are checked by `tsc` (npm run typecheck).
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Executor, Tx } from "../../../src/worker/db/client";
import { retryOnDeadlock } from "../../../src/worker/db/retry";
import { enforceUploadCeilings, recordUsage } from "../../../src/worker/services/ceilings";
import { addStrike } from "../../../src/worker/services/strikes";

type Given = Parameters<Parameters<typeof retryOnDeadlock<void>>[1]>[0];
type RecordUsageOptions = NonNullable<Parameters<typeof recordUsage>[4]>;
type AddStrikeOptions = NonNullable<Parameters<typeof addStrike>[2]>;
type UploadCeilingOptions = Parameters<typeof enforceUploadCeilings>[3];

describe("the tx of a retryOnDeadlock callback", () => {
  it("is what recordUsage, addStrike and enforceUploadCeilings take as { tx }", () => {
    expectTypeOf<Given>().toEqualTypeOf<Tx>();
    expectTypeOf<{ tx: Given }>().toExtend<RecordUsageOptions>();
    expectTypeOf<{ tx: Given }>().toExtend<AddStrikeOptions>();
    expectTypeOf<{ tx: Given }>().toExtend<UploadCeilingOptions>();
    for (const service of [retryOnDeadlock, recordUsage, addStrike, enforceUploadCeilings])
      expect(typeof service).toBe("function");
  });

  it("control: the database handle's type is not — the three keep asking for a real transaction", () => {
    expectTypeOf<{ tx: Executor }>().not.toExtend<RecordUsageOptions>();
    expectTypeOf<{ tx: Executor }>().not.toExtend<AddStrikeOptions>();
    expectTypeOf<{ tx: Executor }>().not.toExtend<UploadCeilingOptions>();
    expect(recordUsage.length).toBeGreaterThan(0);
  });
});
