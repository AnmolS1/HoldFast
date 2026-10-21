// The console's own API (routes/admin.ts). Everything goes through `api()` (the identity pin,
// the error envelope) and through `withStepUp`, which answers `403 admin_requires_2fa` with the
// step-up prompt and then repeats THAT request once. Every key starts with "admin": nothing of it
// outlives the account (the purge empties the cache). Nothing here is polled.
import { z } from "zod";
import {
  AcceptGenerationResponse,
  AddStrikeResponse,
  AdminAuditResponse,
  AdminDashboardDto,
  AdminLinkDto,
  AdminLinkPage,
  AdminQuarantineDetailDto,
  AdminSettingsResponse,
  AdminSystemDto,
  AdminUserDetailDto,
  AdminUserPage,
  ClearLockResponse,
  CreateDmcaNoticeResponse,
  CreateInvitesResponse,
  DeletionResponse,
  DestroyPauseResponse,
  DmcaNoticeDto,
  DmcaNoticePage,
  InviteDto,
  InvitePage,
  KeptUploadPage,
  LiftStrikeResponse,
  LockCsamResponse,
  NcmecEvidenceResponse,
  QuarantineActionResponse,
  QuarantinePage,
  ReleaseHoldsResponse,
  ReportActionResponse,
  ReportDetailDto,
  ReportDto,
  ReportPage,
  ResolveKeptUploadResponse,
  RevokeCountResponse,
  ScannerCheckResponse,
  type AcceptGenerationBody,
  type AddStrikeBody,
  type AdminLinkActionBody,
  type CounterNoticeBody,
  type CreateDmcaNoticeBody,
  type CreateInvitesBody,
  type DestroyPauseBody,
  type DmcaActionBody,
  type LockCsamBody,
  type NcmecFiledBody,
  type PatchSettingsBody,
  type QuarantineActionBody,
  type ReportActionBody,
  type ResolveKeptUploadBody,
  type SetLegalHoldBody,
  type TwoStepBody,
} from "../../../shared/schemas/admin";
import { api, type ApiOptions } from "../../lib/api";
import { withStepUp } from "./step-up";

export const adminKeys = {
  all: ["admin"] as const,
  dashboard: ["admin", "dashboard"] as const,
  users: (query: string) => ["admin", "users", query] as const,
  user: (id: string) => ["admin", "user", id] as const,
  settings: ["admin", "settings"] as const,
  quarantine: (query: string) => ["admin", "quarantine", query] as const,
  quarantineItem: (id: string) => ["admin", "quarantine-item", id] as const,
  kept: ["admin", "kept-uploads"] as const,
  reports: (query: string) => ["admin", "reports", query] as const,
  report: (id: string) => ["admin", "report", id] as const,
  dmca: (query: string) => ["admin", "dmca", query] as const,
  notice: (id: string) => ["admin", "notice", id] as const,
  links: (query: string) => ["admin", "links", query] as const,
  invites: ["admin", "invites"] as const,
  audit: (query: string) => ["admin", "audit", query] as const,
  system: ["admin", "system"] as const,
  stepUp: ["admin", "step-up"] as const,
};

/** Read when a screen is opened and on the admin's own refresh — never polled, never on focus. */
export const ON_DEMAND = {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchInterval: false,
} as const;

const BASE = "/api/admin";

/** One admin request: through `api()`, and through the step-up when the session needs it. */
export function adminApi<T>(path: string, options: ApiOptions<T> = {}): Promise<T> {
  return withStepUp(() => api<T>(`${BASE}${path}`, options));
}

const post = <T>(path: string, schema: z.ZodType<T>, body?: unknown) =>
  adminApi(path, { method: "POST", body, schema });

/** `?a=1&b=2` of the defined values (empty when none). */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const enc = encodeURIComponent;

// ── dashboard ────────────────────────────────────────────────────────────────────────────
export const fetchDashboard = (signal?: AbortSignal) =>
  adminApi("/dashboard", { schema: AdminDashboardDto, signal });

// ── users ────────────────────────────────────────────────────────────────────────────────
export const fetchUsers = (query: string, signal?: AbortSignal) =>
  adminApi(`/users${query}`, { schema: AdminUserPage, signal });
export const fetchUser = (id: string, signal?: AbortSignal) =>
  adminApi(`/users/${enc(id)}`, { schema: AdminUserDetailDto, signal });
export const suspendUser = (id: string, reason: string) =>
  post(`/users/${enc(id)}/suspend`, AdminUserDetailDto, { reason });
export const unsuspendUser = (id: string, reason: string) =>
  post(`/users/${enc(id)}/unsuspend`, AdminUserDetailDto, { reason });
export const revokeSessions = (id: string, reason: string) =>
  post(`/users/${enc(id)}/revoke-sessions`, RevokeCountResponse, { reason });
export const revokeLinks = (id: string, reason: string) =>
  post(`/users/${enc(id)}/revoke-links`, RevokeCountResponse, { reason });
export const setQuota = (id: string, quotaBytes: number) =>
  adminApi(`/users/${enc(id)}/quota`, { method: "PATCH", body: { quotaBytes }, schema: AdminUserDetailDto });
export const addStrike = (id: string, body: AddStrikeBody) =>
  post(`/users/${enc(id)}/strikes`, AddStrikeResponse, body);
export const liftStrike = (strikeId: string, reason: string) =>
  post(`/strikes/${enc(strikeId)}/lift`, LiftStrikeResponse, { reason });
export const setLegalHold = (id: string, body: SetLegalHoldBody) =>
  post(`/users/${enc(id)}/legal-hold`, AdminUserDetailDto, body);
export const scheduleDeletion = (id: string, reason: string) =>
  post(`/users/${enc(id)}/deletion`, DeletionResponse, { reason });
export const cancelDeletion = (id: string, reason: string) =>
  post(`/users/${enc(id)}/deletion/cancel`, DeletionResponse, { reason });

// ── settings ─────────────────────────────────────────────────────────────────────────────
export const fetchSettings = (signal?: AbortSignal) =>
  adminApi("/settings", { schema: AdminSettingsResponse, signal });
export const patchSettings = (body: PatchSettingsBody) =>
  adminApi("/settings", { method: "PATCH", body, schema: AdminSettingsResponse });

// ── quarantine and kept uploads ──────────────────────────────────────────────────────────
export const fetchQuarantine = (query: string, signal?: AbortSignal) =>
  adminApi(`/quarantine${query}`, { schema: QuarantinePage, signal });
export const fetchQuarantineItem = (id: string, signal?: AbortSignal) =>
  adminApi(`/quarantine/${enc(id)}`, { schema: AdminQuarantineDetailDto, signal });
export const quarantineAction = (id: string, body: QuarantineActionBody) =>
  post(`/quarantine/${enc(id)}`, QuarantineActionResponse, body);
export const fetchKeptUploads = (signal?: AbortSignal) =>
  adminApi("/kept-uploads", { schema: KeptUploadPage, signal });
export const resolveKeptUpload = (id: string, body: ResolveKeptUploadBody) =>
  post(`/kept-uploads/${enc(id)}/resolve`, ResolveKeptUploadResponse, body);

// ── reports and the NCMEC procedure ──────────────────────────────────────────────────────
export const fetchReports = (query: string, signal?: AbortSignal) =>
  adminApi(`/reports${query}`, { schema: ReportPage, signal });
export const fetchReport = (id: string, signal?: AbortSignal) =>
  adminApi(`/reports/${enc(id)}`, { schema: ReportDetailDto, signal });
export const assignReport = (id: string, assignToMe: boolean) =>
  post(`/reports/${enc(id)}/assign`, ReportDto, { assignToMe });
export const reportAction = (id: string, body: ReportActionBody) =>
  post(`/reports/${enc(id)}/action`, ReportActionResponse, body);
export const ncmecStart = (id: string) => post(`/reports/${enc(id)}/ncmec/start`, ReportDto);
export const ncmecEvidence = (id: string) =>
  post(`/reports/${enc(id)}/ncmec/evidence`, NcmecEvidenceResponse);
export const ncmecFiled = (id: string, body: NcmecFiledBody) =>
  post(`/reports/${enc(id)}/ncmec/filed`, ReportDetailDto, body);
export const releaseHolds = (id: string, body: TwoStepBody) =>
  post(`/reports/${enc(id)}/release-holds`, ReleaseHoldsResponse, body);
export const clearLock = (id: string, body: TwoStepBody) =>
  post(`/reports/${enc(id)}/clear-lock`, ClearLockResponse, body);
export const lockCsam = (body: LockCsamBody) => post("/moderation/lock-csam", LockCsamResponse, body);

// ── DMCA ─────────────────────────────────────────────────────────────────────────────────
export const fetchNotices = (query: string, signal?: AbortSignal) =>
  adminApi(`/dmca${query}`, { schema: DmcaNoticePage, signal });
export const fetchNotice = (id: string, signal?: AbortSignal) =>
  adminApi(`/dmca/${enc(id)}`, { schema: DmcaNoticeDto, signal });
export const createNotice = (body: CreateDmcaNoticeBody) => post("/dmca", CreateDmcaNoticeResponse, body);
export const noticeAction = (id: string, body: DmcaActionBody) =>
  post(`/dmca/${enc(id)}/action`, DmcaNoticeDto, body);
export const counterNotice = (id: string, body: CounterNoticeBody) =>
  post(`/dmca/${enc(id)}/counter`, DmcaNoticeDto, body);
/** A navigation (opened in a new tab), not a fetch: the printable notice. */
export const noticeExportHref = (id: string) => `${BASE}/dmca/${enc(id)}/export`;

// ── links ────────────────────────────────────────────────────────────────────────────────
export const fetchLinks = (query: string, signal?: AbortSignal) =>
  adminApi(`/links${query}`, { schema: AdminLinkPage, signal });
export const linkAction = (id: string, action: AdminLinkActionBody["action"]) =>
  post(`/links/${enc(id)}`, AdminLinkDto, { action });
export const linkAnomaly = (id: string, paused: boolean, reason: string) =>
  post(`/links/${enc(id)}/anomaly`, AdminLinkDto, { paused, reason });

// ── invites ──────────────────────────────────────────────────────────────────────────────
export const fetchInvites = (signal?: AbortSignal) => adminApi("/invites", { schema: InvitePage, signal });
export const createInvites = (body: CreateInvitesBody) => post("/invites", CreateInvitesResponse, body);
export const revokeInvite = (code: string) => post(`/invites/${enc(code)}/revoke`, InviteDto);
export const invitesExportHref = `${BASE}/invites/export`;

// ── audit ────────────────────────────────────────────────────────────────────────────────
export const fetchAudit = (query: string, signal?: AbortSignal) =>
  adminApi(`/audit${query}`, { schema: AdminAuditResponse, signal });
export const auditExportHref = (query: string) => `${BASE}/audit/export${query}`;

// ── system ───────────────────────────────────────────────────────────────────────────────
export const fetchSystem = (signal?: AbortSignal) => adminApi("/system", { schema: AdminSystemDto, signal });
export const checkScanner = () => post("/system/scanner-check", ScannerCheckResponse);
export const acceptGeneration = (body: AcceptGenerationBody) =>
  post("/system/generation", AcceptGenerationResponse, body);
export const setDestroyPause = (body: DestroyPauseBody) =>
  post("/system/destroy-pause", DestroyPauseResponse, body);

/** One pass of "run job": `{ done }` (200 / 202); a stopped guarded job is thrown as `409`. */
export const JobPass = z.object({ name: z.string().optional(), done: z.boolean() });
export const runJobPass = (name: string) => post(`/jobs/${enc(name)}/run`, JobPass);
