// Imported FIRST by main.tsx, before any module that builds a zod schema.
//
// zod compiles object parsers with `new Function` when it can, and finds out whether it can by
// trying — at the moment a schema is BUILT (`z.object(...)`), not when it parses. Under the
// app's Content-Security-Policy (`script-src` without 'unsafe-eval') that attempt is refused
// and caught, but the browser still records a violation and posts a CSP report: one per page
// load, for every visitor. `jitless` makes zod skip the attempt and use its plain parser.
import { z } from "zod";

z.config({ jitless: true });
