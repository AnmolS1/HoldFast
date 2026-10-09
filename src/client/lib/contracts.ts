// Shapes the shell reads. Defined here because the shell is built before the auth and contract
// tasks; they are structural, so the real session and DTO types are assignable without an import.
import { z } from "zod";

export { PublicConfig } from "../../shared/public-config";
export { ERROR_STATUS } from "../../shared/errors";
export type { ErrorCode, ErrorEnvelope } from "../../shared/errors";

/** The user fields the shell reads from the session. Dates arrive as ISO strings in the browser. */
export const SessionUserShape = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  role: z.string().nullish(),
  timezone: z.string().nullish(),
  termsVersion: z.string().nullish(),
  deleteScheduledAt: z.string().nullish(),
});
export type SessionUserShape = z.infer<typeof SessionUserShape>;

/** `GET /api/auth/get-session`: the session with its user, or `null` when signed out. */
export const SessionShape = z
  .object({
    user: SessionUserShape,
    session: z.object({
      /** Admin plugin: set on an impersonated session to the admin's user id. */
      impersonatedBy: z.string().nullish(),
    }),
  })
  .nullable();
export type SessionShape = z.infer<typeof SessionShape>;

export function isImpersonating(session: SessionShape | undefined): boolean {
  return Boolean(session?.session.impersonatedBy);
}

/** `GET /api/account/deletion-status`. */
export const DeletionStatusShape = z.object({ scheduledFor: z.string().nullable() });
export type DeletionStatusShape = z.infer<typeof DeletionStatusShape>;

/** `GET /api/invites/:code`. */
export const InviteStatusShape = z.object({ valid: z.boolean() });

/** Where the legal texts and help live (the estate site). */
export const EXTERNAL_LINKS = {
  terms: "https://ponderance.dev/terms",
  privacy: "https://ponderance.dev/privacy",
  help: "https://ponderance.dev/support/holdfast",
  support: "https://ponderance.dev/support/holdfast#contact",
} as const;
