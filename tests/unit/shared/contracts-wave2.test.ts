// The Wave-2 additions to the shared contracts: the shapes of the trash, recent, starred and
// upload routes that two tasks must agree on. (Every schema's example, and the strictness of what
// a client sends, are checked with all the others in contracts.test.ts.)
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Page } from "../../../src/shared/schemas/common";
import * as node from "../../../src/shared/schemas/node";
import * as search from "../../../src/shared/schemas/search";
import * as upload from "../../../src/shared/schemas/upload";

const AT = "2026-10-12T12:00:00.000Z";
const user = { id: "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF", displayName: "Ada" };
const file = {
  id: "0199d3c2-7a10-7000-8000-0000000000a1",
  parentId: "0199d3c2-7a10-7000-8000-0000000000b2",
  kind: "file",
  name: "report.pdf",
  ext: "pdf",
  size: 1234,
  mimeCategory: "pdf",
  mimeSniffed: "application/pdf",
  etag: "0199d3c2-7a10-7000-8000-0000000000d4",
  sha256: "ab".repeat(32),
  scanStatus: "clean",
  scanReason: null,
  pua: [],
  thumb: false,
  starred: false,
  createdAt: AT,
  updatedAt: AT,
  lastAccessedAt: null,
  deletedAt: null,
  purgeAfter: null,
  owner: user,
  createdBy: user,
  role: "owner",
  sharing: { people: 0, link: "none", summary: "none" },
};
const trashed = { ...file, deletedAt: AT, purgeAfter: "2026-11-11T12:00:00.000Z" };

describe("trash", () => {
  it("a trash row always says when it was trashed and when it is purged", () => {
    expect(node.TrashItemDto.safeParse(trashed).success).toBe(true);
    expect(node.TrashItemDto.safeParse({ ...trashed, deletedAt: null }).success).toBe(false);
    expect(node.TrashItemDto.safeParse({ ...trashed, purgeAfter: null }).success).toBe(false);
    // The control: the plain node contract takes both as null.
    expect(node.NodeDto.safeParse(file).success).toBe(true);
    expectTypeOf<node.TrashItemDto["deletedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<node.TrashItemDto["purgeAfter"]>().toEqualTypeOf<string>();
  });

  it("GET /trash: the query is paged like a folder listing; the answer is a page of trash rows", () => {
    expect(node.TrashQuery.parse({})).toEqual({ limit: 100 });
    expect(node.TrashQuery.parse({ limit: "200", cursor: "abc" })).toEqual({ limit: 200, cursor: "abc" });
    for (const bad of [{ limit: "201" }, { limit: "0" }, { cursor: "" }, { cursor: "x".repeat(513) }])
      expect(node.TrashQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(node.TrashResponse.safeParse({ items: [trashed], nextCursor: null }).success).toBe(true);
    expect(node.TrashResponse.safeParse({ items: [file], nextCursor: null }).success).toBe(false);
    expect(node.TrashResponse.safeParse([trashed]).success).toBe(false);
    expectTypeOf<node.TrashResponse>().toEqualTypeOf<Page<node.TrashItemDto>>();
  });

  it("trash answers the trashed row, restore the node as it came back", () => {
    expect(node.TrashNodeResponse).toBe(node.TrashItemDto);
    expect(node.RestoreNodeResponse).toBe(node.NodeDto);
    const restored = { ...file, parentId: null, name: "report (restored).pdf" };
    expect(node.RestoreNodeResponse.parse(restored)).toMatchObject({ parentId: null, deletedAt: null });
  });
});

describe("recent and starred", () => {
  it("GET /recent answers { items }, with no cursor", () => {
    expect(search.RecentResponse.safeParse({ items: [file] }).success).toBe(true);
    expect(search.RecentResponse.safeParse([file]).success).toBe(false);
    expectTypeOf<search.RecentResponse>().toEqualTypeOf<{ items: node.NodeDto[] }>();
  });

  it("GET /starred: cursor and a limit of at most 200; the answer is a page of nodes", () => {
    expect(search.StarredQuery.parse({})).toEqual({ limit: 100 });
    expect(search.StarredQuery.parse({ limit: "200" })).toEqual({ limit: 200 });
    for (const bad of [{ limit: "201" }, { limit: "0" }, { limit: "1.5" }, { cursor: "" }])
      expect(search.StarredQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(search.StarredResponse.safeParse({ items: [file], nextCursor: "abc" }).success).toBe(true);
    expect(search.StarredResponse.safeParse({ items: [file] }).success).toBe(false);
    expectTypeOf<search.StarredResponse>().toEqualTypeOf<Page<node.NodeDto>>();
  });

  it('a search result\'s path hint is text: the route sends "" where the query has none', () => {
    expect(search.SearchResultDto.safeParse({ ...file, pathHint: "" }).success).toBe(true);
    expect(search.SearchResultDto.safeParse({ ...file, pathHint: null }).success).toBe(false);
  });
});

describe("uploads", () => {
  it("PUT /uploads/:id/single answers { etag }", () => {
    expect(upload.SinglePutResponse.parse({ etag: "abc" })).toEqual({ etag: "abc" });
    expect(upload.SinglePutResponse.safeParse({}).success).toBe(false);
    expect(upload.SinglePutResponse.safeParse({ n: 1, etag: 5 }).success).toBe(false);
  });

  it("GET /uploads/open answers a bare array of sessions", () => {
    const session = {
      uploadId: "0199d3c2-7a10-7000-8000-0000000000c3",
      parentId: null,
      name: "video.mp4",
      size: 140_000_000,
      partBytes: 67_108_864,
      partCount: 3,
      uploadedParts: 1,
      fileLastModified: AT,
      createdAt: AT,
      expiresAt: AT,
    };
    expect(upload.OpenUploadsResponse.safeParse([]).success).toBe(true);
    expect(upload.OpenUploadsResponse.safeParse([session]).success).toBe(true);
    expect(upload.OpenUploadsResponse.safeParse({ items: [session] }).success).toBe(false);
    expectTypeOf<upload.OpenUploadsResponse>().toEqualTypeOf<upload.UploadSessionDto[]>();
  });

  it("a search query is trimmed before it is measured and carries no control character", () => {
    expect(search.SearchQuery.parse({ q: "  report  " }).q).toBe("report");
    expect(search.SearchQuery.safeParse({ q: " a " }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "ab\u0000" }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "ab\u0000cd" }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "ab\tcd" }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "ab\u007fcd" }).success).toBe(false);
    expect(search.SearchQuery.parse({ q: "résumé 2026" }).q).toBe("résumé 2026");
  });
});
