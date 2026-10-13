// A type-level test: `NodeDto` (the contract) must be assignable to `FileListItem` (what the
// shared file list renders). Vitest does not typecheck — this file is compiled by
// `npm run typecheck` (tsconfig.tests.workers.json includes tests/unit/**/*.ts), and that is the
// test: if a field of the DTO stops fitting the component, `tsc -b` fails here.
//
// If it ever fails, the component's contract is the one to keep; the DTO field is what to report.
import type { FileListItem } from "../../../src/client/components/types";
import type { AdminNodeDto } from "../../../src/shared/schemas/admin";
import type { NodeDto } from "../../../src/shared/schemas/node";
import type { SearchResultDto } from "../../../src/shared/schemas/search";

type Assignable<From, To> = [From] extends [To] ? true : false;

/** Compiles only when `T` is exactly `true`. */
type Expect<T extends true> = T;

export type NodeDtoFitsFileList = Expect<Assignable<NodeDto, FileListItem>>;
export type SearchResultFitsFileList = Expect<Assignable<SearchResultDto, FileListItem>>;
// The admin node carries the seventh status, which the list knows how to show.
export type AdminNodeFitsFileList = Expect<Assignable<AdminNodeDto, FileListItem>>;

// The checker itself can say no (so a "true" above means something).
export type CheckerRefuses = Expect<Assignable<{ id: number }, FileListItem> extends false ? true : false>;

/** The same thing as a value: an assignment the compiler must accept. */
export function asFileListItem(node: NodeDto): FileListItem {
  return node;
}
