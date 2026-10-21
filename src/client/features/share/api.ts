// The sharing API as the SPA calls it: every call through `api()` (the identity pin, the error
// envelope, the cross-cutting statuses), every answer through its shared schema.
//
// ACCOUNT CHANGE. The query cache is the shell's: `purgeUserState` drops every key below with the
// account. What outlives a request — a mutation's answer arriving after a sign-out or a switch to
// another account in another tab — goes through `forThisAccount`: an answer for the previous
// account is dropped, never written into the next account's cache or dialog state.
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  LinkActivityDto,
  LinkDto,
  type CreateLinkBody,
  type PatchLinkBody,
} from "../../../shared/schemas/link";
import {
  NodeSharingDto,
  ShareDto,
  SharedWithMeDto,
  SharesMineDto,
  type CreateShareBody,
  type PatchShareBody,
} from "../../../shared/schemas/share";
import { api, type ApiErrorCode } from "../../lib/api";
import { accountEpoch, queryClient, sameAccount } from "../../lib/query";

const node = (nodeId: string) => `/api/nodes/${encodeURIComponent(nodeId)}`;

export const sharingKeys = {
  all: ["sharing"] as const,
  node: (nodeId: string) => ["sharing", "node", nodeId] as const,
  withMe: ["sharing", "with-me"] as const,
  sharesMine: ["sharing", "shares-mine"] as const,
  linksMine: ["sharing", "links-mine"] as const,
  activity: (linkId: string) => ["sharing", "activity", linkId] as const,
};

/**
 * Runs `request`, and hands its answer on only while the account that started it is still the
 * one this tab holds. Resolves to `{ dropped: true }` otherwise — the caller then does nothing.
 */
export async function forThisAccount<T>(
  request: () => Promise<T>,
): Promise<{ dropped: true } | { dropped: false; value: T }> {
  const then = accountEpoch();
  try {
    const value = await request();
    return sameAccount(then) ? { dropped: false, value } : { dropped: true };
  } catch (error) {
    if (!sameAccount(then)) return { dropped: true };
    throw error;
  }
}

/** After a change: every sharing list is read again (the account check is the caller's). */
export function refreshSharing(): void {
  void queryClient.invalidateQueries({ queryKey: sharingKeys.all });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────

export function useNodeSharing(nodeId: string | null) {
  return useQuery({
    queryKey: sharingKeys.node(nodeId ?? ""),
    queryFn: ({ signal }) => api(`${node(nodeId!)}/sharing`, { schema: NodeSharingDto, signal }),
    enabled: nodeId !== null,
  });
}

export function useSharedWithMe() {
  return useQuery({
    queryKey: sharingKeys.withMe,
    queryFn: ({ signal }) => api("/api/shared-with-me", { schema: z.array(SharedWithMeDto), signal }),
  });
}

export function useSharesMine() {
  return useQuery({
    queryKey: sharingKeys.sharesMine,
    queryFn: ({ signal }) => api("/api/shares/mine", { schema: z.array(SharesMineDto), signal }),
  });
}

export function useLinksMine() {
  return useQuery({
    queryKey: sharingKeys.linksMine,
    queryFn: ({ signal }) => api("/api/links/mine", { schema: z.array(LinkDto), signal }),
  });
}

export function useLinkActivity(linkId: string) {
  return useQuery({
    queryKey: sharingKeys.activity(linkId),
    queryFn: ({ signal }) =>
      api(`/api/links/${encodeURIComponent(linkId)}/activity`, { schema: LinkActivityDto, signal }),
    staleTime: 60_000,
  });
}

// ── changes ─────────────────────────────────────────────────────────────────────────────────

/** Codes a caller says itself, in its own words: no toast for them. */
const OWN_WORDS: readonly ApiErrorCode[] = ["validation", "conflict", "ceiling_exceeded", "feature_disabled"];

export const createShare = (nodeId: string, body: CreateShareBody) =>
  api(`${node(nodeId)}/shares`, { method: "POST", body, schema: ShareDto, silent: OWN_WORDS });

export const patchShare = (shareId: string, body: PatchShareBody) =>
  api(`/api/shares/${encodeURIComponent(shareId)}`, { method: "PATCH", body, schema: ShareDto });

export const removeShare = (shareId: string) =>
  api(`/api/shares/${encodeURIComponent(shareId)}`, { method: "DELETE", empty: true });

export const createLink = (nodeId: string, body: CreateLinkBody) =>
  api(`${node(nodeId)}/links`, { method: "POST", body, schema: LinkDto, silent: OWN_WORDS });

export const patchLink = (linkId: string, body: PatchLinkBody) =>
  api(`/api/links/${encodeURIComponent(linkId)}`, { method: "PATCH", body, schema: LinkDto });

export const revokeLink = (linkId: string) =>
  api(`/api/links/${encodeURIComponent(linkId)}`, { method: "DELETE", empty: true });
