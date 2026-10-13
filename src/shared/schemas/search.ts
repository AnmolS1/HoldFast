// Search and recent.

import { z } from "zod";
import { MimeCategory, NodeId, Page } from "./common";
import { NodeDto, NodeKind } from "./node";

/** `category` is one of the eight category keys — the only category vocabulary there is. */
export const SearchQuery = z.strictObject({
  q: z.string().min(2).max(100),
  kind: NodeKind.optional(),
  category: MimeCategory.optional(),
  scope: z.enum(["mine", "shared", "all"]).default("all"),
  inFolder: NodeId.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** A node with its path hint. */
export const SearchResultDto = NodeDto.extend({ pathHint: z.string() });
export type SearchResultDto = z.infer<typeof SearchResultDto>;

export const SearchResponse = Page(SearchResultDto);
export type SearchResponse = z.infer<typeof SearchResponse>;

export const RecentQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).default(20) });
export type RecentQuery = z.infer<typeof RecentQuery>;
