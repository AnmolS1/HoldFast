// THE CONTRACTS OF src/shared ARE FROZEN after the contracts task. A gap or a mistake goes to the
// orchestrator; it is not fixed by editing a schema from a feature task.
//
// What lives here is compiled for BOTH the browser and the Worker (tsconfig.app.json and
// tsconfig.worker.json): no Workers types, no DOM types, no Node APIs, and no dependency a page
// should not download (the file-type detector stays in the Worker).
//
//   constants.ts          numbers and names both sides must agree on
//   errors.ts             the error codes and their statuses (the worker core's file)
//   ids.ts                the two id families and the token shape
//   public-config.ts      `PublicConfig`, the body of GET /api/public/config — its one definition
//   schemas/common.ts     ids, timestamps, UserRef, Page, Role, ScanStatus, MimeCategory, ErrorBody
//   schemas/node.ts       files and folders, listings, download and thumbnail URLs, zip
//   schemas/upload.ts     upload sessions
//   schemas/share.ts      shares with people
//   schemas/link.ts       public links: the owner's view and the public page's
//   schemas/search.ts     search and recent
//   schemas/account.ts    usage, preferences, profile, sessions, activity, deletion, export
//   schemas/report.ts     the abuse report form
//   schemas/admin.ts      the admin console
//
// CONVENTIONS
//   - Every schema `X` also exports `type X = z.infer<typeof X>`.
//   - Ids are strings: a user or session id is `UserId` (32 alphanumeric characters), every id of
//     our own rows is `NodeId` / `RowId` (a UUID). The two are never interchangeable.
//   - Timestamps are ISO-8601 strings (`Timestamp`), byte counts are numbers.
//   - What a CLIENT SENDS (`…Body`, `…Query`) is strict: an unknown field is a validation error.
//     What the SERVER ANSWERS (`…Dto`, `…Response`) is not: a client ignores what it does not know.
//   - A DTO never carries an object key, an email address of another person, an IP address or a
//     token — except where the field's own comment says so.
//   - A route named in a comment is a contract for the task that owns the route; nothing here
//     implements one.
//   - Query parameters arrive as text: numeric and boolean query fields coerce.
export {};
