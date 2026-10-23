// Shared by the admin console's jsdom tests: an admin session, a scripted /api/admin/* and
// fixtures that parse as the shared admin contracts.
import { configure, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, vi } from "vitest";
import { buildRoutes } from "../../../../src/client/router";
import { json, renderRoutes, sessionOf, shellFetch, type MockCall, type MockHandler } from "../shell/helpers";

export const ADMIN_ID = "A".repeat(32);
export const OTHER_ID = "B".repeat(32);
export const NODE = "0199d3c2-7a10-7000-8000-0000000000a1";
export const REPORT = "0199d3c2-7a10-7000-8000-0000000000c3";
export const AT = new Date(Date.now() - 3_600_000).toISOString();
const SHA = "ab".repeat(32);

export const adminSession = (patch: Parameters<typeof sessionOf>[0] = {}) =>
  sessionOf({ id: ADMIN_ID, role: "admin", ...patch });

const userRef = { id: OTHER_ID, displayName: "Bea" };

export function adminNode(patch: Record<string, unknown> = {}) {
  return {
    id: NODE,
    parentId: null,
    kind: "file",
    name: "evidence.bin",
    ext: "bin",
    size: 1234,
    mimeCategory: "other",
    mimeSniffed: "application/octet-stream",
    etag: "v1",
    sha256: SHA,
    scanStatus: "under_review",
    scanReason: null,
    pua: [],
    thumb: false,
    starred: false,
    createdAt: AT,
    updatedAt: AT,
    lastAccessedAt: null,
    deletedAt: null,
    purgeAfter: null,
    owner: userRef,
    createdBy: userRef,
    role: "viewer",
    sharing: { people: 0, link: "none", summary: "none" },
    takedown: null,
    legalHold: false,
    ...patch,
  };
}

export function report(patch: Record<string, unknown> = {}) {
  return {
    id: REPORT,
    nodeId: NODE,
    linkId: null,
    ownerId: OTHER_ID,
    category: "spam",
    source: "user",
    reporterEmail: null,
    reporterUserId: null,
    details: "Looks like spam.",
    status: "open",
    assignedTo: null,
    resolution: null,
    createdAt: AT,
    resolvedAt: null,
    ncmecStartedAt: null,
    ncmecFiledAt: null,
    ncmecReportId: null,
    node: adminNode(),
    ...patch,
  };
}

export function reportDetail(patch: Record<string, unknown> = {}, reportPatch: Record<string, unknown> = {}) {
  return {
    report: report(reportPatch),
    openOnNode: 1,
    distinctReporters: 1,
    uploader: { id: OTHER_ID, displayName: "Bea", createdAt: AT, strikes: [] },
    links: { count: 0, downloads: 0, bytesServed: 0, lastAccessAt: null },
    locked: null,
    alerts: [],
    nodeIsFolder: false,
    releasableAt: null,
    ...patch,
  };
}

export const adminUser = (patch: Record<string, unknown> = {}) => ({
  id: OTHER_ID,
  email: "bea@example.test",
  displayName: "Bea",
  role: "user",
  emailVerified: true,
  twoFactorEnabled: false,
  createdAt: AT,
  quotaBytes: 5_000_000_000,
  usedBytes: 340,
  banned: false,
  banReason: null,
  suspendedAt: null,
  suspendedReason: null,
  deleteScheduledAt: null,
  legalHold: false,
  activeStrikes: 0,
  lastActiveAt: null,
  ...patch,
});

export const userDetail = (patch: Record<string, unknown> = {}) => ({
  user: adminUser(),
  linkEgressToday: { bytes: 62_000_000_000, count: 40, capBytes: 100_000_000_000 },
  usage: {
    usedBytes: 340,
    filesBytes: 100,
    trashBytes: 0,
    versionsBytes: 0,
    reservedBytes: 0,
    keptDeletedBytes: 240,
    keptBackstopReached: false,
  },
  strikes: [],
  sessions: 1,
  links: { live: 2, paused: 1 },
  shares: 0,
  legalHoldByHand: false,
  ...patch,
});

export const dashboard = () => ({
  users: { total: 3, new7d: 1 },
  storageBytes: 1000,
  uploads24h: 0,
  downloads24h: { count: 0, bytes: 0 },
  scans24h: {},
  scanBacklog: { running: 0, oldestStartedAt: null },
  nodesInError: 0,
  reports: { open: 0, oldestOpenAt: null },
  strikes7d: 0,
  linksPaused: {},
  pauseSwitch: "off",
  analytics: { available: false },
});

export const detector = (patch: Record<string, unknown> = {}) => ({
  object: { raw: "7", number: 7 },
  database: { raw: "7", number: 7 },
  reading: "level",
  pauseSwitch: "off",
  orphanDeleteEnabled: true,
  ...patch,
});

export const system = (patch: Record<string, unknown> = {}) => ({
  build: { sha: "abc1234", builtAt: AT },
  database: { ok: true },
  storage: { ok: true },
  flags: { photodnaEnabled: false, scanStub: true },
  scannerAvailable: false,
  jobs: [{ name: "purge", cron: "17 */6 * * *", guarded: true, streamed: false }],
  detector: detector(),
  ...patch,
});

export const quarantineDetail = (patch: Record<string, unknown> = {}) => ({
  item: {
    node: adminNode({ scanStatus: "infected" }),
    uploader: userRef,
    signatures: ["Eicar"],
    scannedAt: AT,
  },
  owner: userRef,
  scanReason: null,
  scanDetail: null,
  sha256: SHA,
  holds: [],
  links: [],
  malwareStrikeId: null,
  ...patch,
});

/** Every /api/admin/* GET of the console, answered from these fixtures (a test overrides any). */
export const DEFAULT_ADMIN: Record<string, unknown> = {
  "/api/admin/dashboard": dashboard(),
  "/api/admin/users": { items: [adminUser()], nextCursor: null },
  [`/api/admin/users/${OTHER_ID}`]: userDetail(),
  "/api/admin/settings": {
    settings: {
      signupMode: "invite",
      uploadsEnabled: true,
      linksEnabled: true,
      readOnly: false,
      demoMode: false,
      orphanDeleteEnabled: true,
      ceilings: {},
      termsVersion: "2026-10",
    },
    ceilingDefaults: { CEIL_OWNER_LINK_BYTES_DAY: 100_000_000_000 },
    termsAccounts: 3,
  },
  "/api/admin/quarantine": {
    items: [
      { node: adminNode({ scanStatus: "suspected_csam" }), uploader: null, signatures: [], scannedAt: null },
    ],
    nextCursor: null,
  },
  [`/api/admin/quarantine/${NODE}`]: quarantineDetail(),
  "/api/admin/kept-uploads": { items: [], nextCursor: null },
  "/api/admin/reports": { items: [report()], nextCursor: null },
  [`/api/admin/reports/${REPORT}`]: reportDetail(),
  "/api/admin/dmca": { items: [], nextCursor: null },
  "/api/admin/links": { items: [], nextCursor: null },
  "/api/admin/invites": { items: [], nextCursor: null },
  "/api/admin/audit": { items: [], nextCursor: null, actors: {} },
  "/api/admin/system": system(),
};

/** The console's screens, each with the one read it makes on open. */
export const SCREENS: Array<{ path: string; read: string }> = [
  { path: "/admin", read: "/api/admin/dashboard" },
  { path: "/admin/users", read: "/api/admin/users" },
  { path: `/admin/users/${OTHER_ID}`, read: `/api/admin/users/${OTHER_ID}` },
  { path: "/admin/settings", read: "/api/admin/settings" },
  { path: "/admin/quarantine", read: "/api/admin/quarantine" },
  { path: `/admin/quarantine/${NODE}`, read: `/api/admin/quarantine/${NODE}` },
  { path: "/admin/kept-uploads", read: "/api/admin/kept-uploads" },
  { path: "/admin/reports", read: "/api/admin/reports" },
  { path: `/admin/reports/${REPORT}`, read: `/api/admin/reports/${REPORT}` },
  { path: "/admin/dmca", read: "/api/admin/dmca" },
  { path: "/admin/links", read: "/api/admin/links" },
  { path: "/admin/invites", read: "/api/admin/invites" },
  { path: "/admin/audit", read: "/api/admin/audit" },
  { path: "/admin/system", read: "/api/admin/system" },
];

const pathOnly = (call: MockCall) => call.path.split("?")[0]!;

/** An admin session and the console's API: `extra` first, then the GET fixtures. */
export function adminFetch(extra: MockHandler = () => undefined, fixtures = DEFAULT_ADMIN) {
  return shellFetch({
    session: adminSession(),
    extra: (call) => {
      const own = extra(call);
      if (own) return own;
      if (call.method === "GET" && pathOnly(call) in fixtures) return json(fixtures[pathOnly(call)]);
      return undefined;
    },
  });
}

// The console is a lazy chunk; its first import (the transform of the whole console) can outlast a
// find's 1 s on a slow runner, leaving the page on "Loading". Every file that opens it imports it
// once first, so each test waits on the console, not on the module graph.
beforeAll(async () => {
  await import("../../../../src/client/features/admin/AdminConsole");
}, 60_000);

// A console screen renders in ~1.3 s on a CI runner (67 tests took 88 s), past find/waitFor's 1 s:
// the files that open it wait up to 5 s per find, inside a 20 s test budget.
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });

export function openConsole(path: string) {
  return renderRoutes(buildRoutes(), [path]);
}

export const consolePage = () => document.querySelector("[data-admin-page]");

export async function untilConsole() {
  await waitFor(() => expect(consolePage()).not.toBeNull());
}

export const adminCalls = (calls: MockCall[]) => calls.filter((call) => call.path.startsWith("/api/admin/"));

/** Content the console must never ask for: a files-host path, or a route that mints one. */
export const contentCalls = (calls: MockCall[]) =>
  calls.filter(
    (call) =>
      /(^|\/)(t|i|d)\//.test(call.path) ||
      /(thumb|download|preview|zip)[-_]?(url|urls|manifest)/.test(call.path),
  );

export { screen };
