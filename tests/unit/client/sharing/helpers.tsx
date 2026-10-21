// Shared by the sharing SPA tests: fixtures in the shared schemas' shapes, and the public page
// rendered from the REAL route tree over a fetch router (no session: it is a public page).
import { act } from "@testing-library/react";
import type { LinkDto, PublicLinkInfo, PublicNodeDto } from "../../../../src/shared/schemas/link";
import { buildRoutes } from "../../../../src/client/router";
import { mockFetch, renderRoutes, shellFetch, type MockCall, type MockHandler } from "../shell/helpers";
import { answering, type Answers } from "../views/helpers";

export { answering, openView, pathOf, requests, type Answers } from "../views/helpers";
export { envelope, json, sessionOf, setupShell, type MockCall } from "../shell/helpers";

export const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
export const AT = "2099-01-01T00:00:00.000Z";
export const FILE_ID = "0199d3c2-7a10-7000-8000-0000000000f1";
export const FOLDER_ID = "0199d3c2-7a10-7000-8000-0000000000d1";
export const LINK_ID = "0199d3c2-7a10-7000-8000-00000000011a";

export function publicFile(overrides: Partial<PublicNodeDto> = {}): PublicNodeDto {
  return {
    id: FILE_ID,
    name: "report.txt",
    kind: "file",
    size: 1234,
    mimeCategory: "document",
    ext: "txt",
    mimeSniffed: "text/plain",
    thumb: false,
    ...overrides,
  };
}

export function publicFolder(overrides: Partial<PublicNodeDto> = {}): PublicNodeDto {
  return {
    ...publicFile({ id: FOLDER_ID, name: "Holiday", kind: "folder", ext: "", size: 0 }),
    ...overrides,
  };
}

export function info(node: PublicNodeDto | null, overrides: Partial<PublicLinkInfo> = {}): PublicLinkInfo {
  return { requiresPassword: false, node, allowPreview: true, dangerous: false, ...overrides };
}

export function link(overrides: Partial<LinkDto> = {}): LinkDto {
  return {
    id: LINK_ID,
    nodeId: FILE_ID,
    node: { name: "report.txt", kind: "file" },
    url: `http://localhost:3000/s/${TOKEN}`,
    state: "active",
    pausedReasons: [],
    canUnpause: false,
    expiresAt: null,
    hasPassword: false,
    maxDownloads: null,
    downloadCount: 0,
    bytesServed: 0,
    allowPreview: true,
    createdAt: AT,
    lastAccessAt: null,
    limitedToday: false,
    ...overrides,
  };
}

/** `POST …/download-url` answered with a made-up files-host URL. */
export const minted = (kind = "d", id = FILE_ID) => ({
  url: `http://files.localhost:3000/${kind}/${id}/made-up-token`,
  expiresAt: AT,
});

export const publicPath = (rest = "") => `/api/public/links/${TOKEN}${rest}`;

/** Open `/s/<TOKEN>` signed out; `answers` keyed "METHOD /api/…". */
export async function openPublic(
  answers: Answers,
): Promise<{ calls: MockCall[] } & ReturnType<typeof renderRoutes>> {
  const calls = shellFetch({ session: null, extra: answering(answers) });
  const view = renderRoutes(buildRoutes(), [`/s/${TOKEN}`]);
  await act(async () => {});
  return { calls, ...view };
}

/** The API calls of the public link, by "METHOD /path-after-the-token". */
export const publicCalls = (calls: MockCall[]) =>
  calls
    .filter((call) => call.path.startsWith(publicPath()))
    .map((call) => `${call.method} ${call.path.slice(publicPath().length).split("?")[0] || "/"}`);

/** A fetch router for code that runs without the page (the link client alone). */
export const mockFetchCalls = (handler: MockHandler): MockCall[] => mockFetch(handler);
