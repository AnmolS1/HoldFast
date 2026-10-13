// `PreviewItem` — what a public preview source hands the preview dialog — may say whether a
// thumbnail exists and what the scan found, as a node does. Type-level: checked by `tsc`.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PreviewItem } from "../../../../src/client/components/slots";
import type { ScanStatus } from "../../../../src/client/components/types";
import type { NodeDto } from "../../../../src/shared/schemas/node";

describe("PreviewItem", () => {
  it("thumb and scanStatus are optional, and a source that gives neither is still a valid item", () => {
    expectTypeOf<PreviewItem["thumb"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PreviewItem["scanStatus"]>().toEqualTypeOf<ScanStatus | undefined>();
    const bare: PreviewItem = { id: "n1", name: "a.png", size: 1, mimeCategory: "image", ext: "png" };
    expect(Object.keys(bare)).not.toContain("thumb");
  });

  it("a node of the API is assignable to it, both fields included", () => {
    expectTypeOf<NodeDto>().toExtend<PreviewItem>();
    expectTypeOf<NodeDto["scanStatus"]>().toExtend<NonNullable<PreviewItem["scanStatus"]>>();
    expect(true).toBe(true);
  });
});
