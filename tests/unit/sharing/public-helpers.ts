// What the public-link tests share: a link made through the owner's API (so its token is a real
// one), requests as a stranger with no session, and reading a minted files-host token.
import { HEADER_LINK_SESSION } from "../../../src/shared/constants";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { api, asCaller, member, settingsWith, type Answer, type ApiOptions } from "./helpers";

export type Member = Awaited<ReturnType<typeof member>>;
export type Made = { id: string; token: string; url: string };

/** A link through `POST /nodes/:id/links`: its row id and its real token. */
export async function linkTo(
  owner: Member,
  nodeId: string,
  body: Record<string, unknown> = {},
  settings: Settings = settingsWith(),
): Promise<Made> {
  const answer = await api(asCaller(owner), `/nodes/${nodeId}/links`, {
    json: { allowPreview: true, ...body },
    settings,
  });
  if (answer.status !== 201)
    throw new Error(`link not created: ${answer.status} ${JSON.stringify(answer.body)}`);
  const { id, url } = answer.body as { id: string; url: string };
  return { id, url, token: url.slice(url.lastIndexOf("/") + 1) };
}

export type PublicOptions = ApiOptions & { session?: string };

/** One request to `/api/public/links/<token><rest>` by a visitor with no account. */
export function visit(token: string, rest = "", options: PublicOptions = {}): Promise<Answer> {
  const { session, ...more } = options;
  return api(null, `/public/links/${token}${rest}`, {
    ...more,
    headers: { ...more.headers, ...(session ? { [HEADER_LINK_SESSION]: session } : {}) },
  });
}

/** `POST …/unlock`; the session token on success. */
export async function unlock(token: string, password: string, options: PublicOptions = {}) {
  const answer = await visit(token, "/unlock", { ...options, json: { password } });
  return { answer, session: (answer.body as { linkSession?: string } | null)?.linkSession };
}

/** `POST …/download-url`. */
export const mint = (token: string, body: Record<string, unknown>, options: PublicOptions = {}) =>
  visit(token, "/download-url", { ...options, json: body });

/** The claims of a minted files-host URL (its payload half; the signature is not checked here). */
export function claimsOf(url: string): Record<string, unknown> {
  const token = url.slice(url.lastIndexOf("/") + 1);
  const body = token.split(".")[0]!;
  const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}
