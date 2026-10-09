// Owner: T07 (worker core), then T10, which takes the file over unchanged.
// This is the single definition of `PublicConfig`: the body of GET /api/public/config. Nothing
// secret is ever added to it. Compiled for both the browser and the Worker.

import { z } from "zod";

export const PublicConfig = z.object({
  signupMode: z.enum(["invite", "open"]),
  quotaBytes: z.number(),
  maxFileBytes: z.number(),
  partBytes: z.number(),
  turnstileSiteKey: z.string(),
  appOrigin: z.string(),
  filesOrigin: z.string(),
  termsVersion: z.string(),
  uploadsEnabled: z.boolean(),
  linksEnabled: z.boolean(),
  readOnly: z.boolean(),
  sentryDsnWeb: z.string().nullable(),
  sentryEnvironment: z.string(),
  release: z.string(),
});

export type PublicConfig = z.infer<typeof PublicConfig>;
