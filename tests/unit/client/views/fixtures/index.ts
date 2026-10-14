// Answers of the API the views read, for the jsdom tests and the mocked e2e spec. Every fixture
// is parsed with its shared schema right here, so one that drifts from the contract fails at
// import — in every test that uses it.
import { UsageDto } from "../../../../../src/shared/schemas/account";
import {
  EmptyTrashResponse,
  NodeDto,
  RestoreNodeResponse,
  TrashItemDto,
  TrashResponse,
} from "../../../../../src/shared/schemas/node";
import {
  RecentResponse,
  SearchResponse,
  SearchResultDto,
  StarredResponse,
} from "../../../../../src/shared/schemas/search";

/** A made-up person: the owner of every fixture node (the id `mockShell` and the unit helpers sign in). */
const OWNER = { id: "a".repeat(32), displayName: "Ada Lovelace" };

/** A UUID v7-shaped id, stable per number. */
export const nodeId = (n: number): string => `01920000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export const FOLDER_ID = nodeId(900);

export function node(n: number, patch: Partial<NodeDto> = {}): NodeDto {
  return NodeDto.parse({
    id: nodeId(n),
    parentId: null,
    kind: "file",
    name: `file-${n}.pdf`,
    ext: "pdf",
    size: 1000 * (n + 1),
    mimeCategory: "pdf",
    mimeSniffed: "application/pdf",
    etag: `etag-${n}`,
    sha256: null,
    scanStatus: "clean",
    scanReason: null,
    pua: [],
    thumb: false,
    starred: false,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    lastAccessedAt: null,
    deletedAt: null,
    purgeAfter: null,
    owner: OWNER,
    createdBy: OWNER,
    role: "owner",
    sharing: { people: 0, link: "none", summary: "none" },
    ...patch,
  });
}

export function trashItem(n: number, patch: Partial<TrashItemDto> = {}): TrashItemDto {
  return TrashItemDto.parse({
    ...node(n),
    deletedAt: "2026-10-02T10:00:00.000Z",
    purgeAfter: "2026-11-01T10:00:00.000Z",
    ...patch,
  });
}

export function trashPage(items: TrashItemDto[], nextCursor: string | null = null): TrashResponse {
  return TrashResponse.parse({ items, nextCursor });
}

/** `count` trashed files, numbered from 1. */
export const trashItems = (count: number): TrashItemDto[] =>
  Array.from({ length: count }, (_, index) => trashItem(index + 1));

/** The trash the journeys use: a file from a folder, a file from the top level, a folder. */
export const TRASH = trashPage([
  trashItem(1, { name: "report.pdf", parentId: FOLDER_ID }),
  trashItem(2, { name: "notes.txt", ext: "txt", mimeCategory: "document", mimeSniffed: "text/plain" }),
  trashItem(3, { name: "Old projects", kind: "folder", ext: "", size: 0, mimeSniffed: null }),
]);

export const restored = (item: TrashItemDto, patch: Partial<NodeDto> = {}): RestoreNodeResponse =>
  RestoreNodeResponse.parse({ ...item, deletedAt: null, purgeAfter: null, ...patch });

/** "Now" for the Recent fixtures: the tests and the e2e spec set the clock to it. */
export const RECENT_NOW = "2026-10-13T12:00:00.000Z";

/** Newest first, as the API answers: opened today, yesterday, four days ago, last month. */
export const RECENT = RecentResponse.parse({
  items: [
    node(11, { name: "today.pdf", lastAccessedAt: "2026-10-13T08:00:00.000Z" }),
    node(12, { name: "yesterday.pdf", lastAccessedAt: "2026-10-12T20:00:00.000Z" }),
    node(13, { name: "this-week.pdf", lastAccessedAt: "2026-10-09T08:00:00.000Z" }),
    node(14, { name: "earlier.pdf", lastAccessedAt: "2026-09-13T08:00:00.000Z" }),
  ],
});

export const STARRED = StarredResponse.parse({
  items: [
    node(21, { name: "Projects", kind: "folder", ext: "", size: 0, mimeSniffed: null, starred: true }),
    node(22, { name: "contract.pdf", starred: true }),
  ],
  nextCursor: null,
});

export function result(n: number, patch: Partial<SearchResultDto> = {}): SearchResultDto {
  return SearchResultDto.parse({ ...node(n), pathHint: "", ...patch });
}

/** What `q=reprot` finds: the typo still matches `report.pdf`; one hit sits at the top level. */
export const SEARCH = SearchResponse.parse({
  items: [
    result(31, { name: "report.pdf", pathHint: "Work" }),
    result(32, {
      name: "reported-bugs.txt",
      ext: "txt",
      mimeCategory: "document",
      mimeSniffed: "text/plain",
      pathHint: "",
    }),
    result(33, { name: "Reports", kind: "folder", ext: "", size: 0, mimeSniffed: null, pathHint: "Work" }),
  ],
  nextCursor: null,
});

/** The same search narrowed to PDFs. */
export const SEARCH_PDF = SearchResponse.parse({ items: [SEARCH.items[0]], nextCursor: null });

export const SEARCH_NONE = SearchResponse.parse({ items: [], nextCursor: null });

export function usage(patch: Partial<UsageDto> = {}): UsageDto {
  return UsageDto.parse({
    usedBytes: 1_400_000_000,
    quotaBytes: 5_000_000_000,
    filesBytes: 900_000_000,
    trashBytes: 300_000_000,
    versionsBytes: 150_000_000,
    reservedBytes: 50_000_000,
    ...patch,
  });
}

export const USAGE = usage();

/** The same account once its trash is gone. */
export const USAGE_AFTER_EMPTY = usage({ usedBytes: 1_100_000_000, trashBytes: 0 });

export const remaining = (count: number): EmptyTrashResponse =>
  EmptyTrashResponse.parse({ remaining: count });
