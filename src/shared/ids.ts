// Id and token shapes, one source string each. Environment-neutral (no Workers or DOM types):
// the Worker's route patterns, the shared zod schemas and the SPA all read the same strings.
//
// `*_PARAM` is the unanchored fragment a Hono path parameter takes:
//   router.get(`/nodes/:id{${UUID_PARAM}}`, …)   router.get(`/admin/users/:userId{${BA_ID_PARAM}}`, …)
// The anchored `RegExp` of the same name is for validators and tests.
//
// The two id families are never interchangeable: our own rows (nodes, uploads, shares, links) have
// UUIDs; Better Auth's rows (users, sessions) have its default 32-character alphanumeric ids.

/** Node, upload, share and link ids. */
export const UUID_PARAM = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID = new RegExp(`^${UUID_PARAM}$`);

/** Bearer-ish tokens in a path (public links, invites by token). */
export const TOKEN_PARAM = "[A-Za-z0-9_-]{16,}";
export const TOKEN = new RegExp(`^${TOKEN_PARAM}$`);

/** Better Auth user and session ids: its default generator, 32 characters of [A-Za-z0-9]. */
export const BA_ID_PARAM = "[A-Za-z0-9]{32}";
export const BA_ID = new RegExp(`^${BA_ID_PARAM}$`);
