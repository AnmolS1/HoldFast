// The Vitest hook's handler wrapper (scripts/route-coverage/handler-hit.ts) on a real Hono app.
import { Hono, type Handler } from "hono";
import { expect, it } from "vitest";
import { wrapRouteHandler } from "../../../scripts/route-coverage/handler-hit";
import type { Hit } from "../../../scripts/route-coverage/routes";

it("a hit carries the status of the answer the handler returned: a 404 is recorded as 404 (review D2)", async () => {
  const hits: Hit[] = [];
  const app = new Hono();
  app.get(
    "/api/nodes/:id",
    wrapRouteHandler(
      (c) => c.json({ error: "not_found" }, 404),
      (hit) => hits.push(hit),
      () => "a.test.ts",
    ) as Handler,
  );
  await app.request("http://localhost/api/nodes/x");
  expect(hits.map((hit) => hit.status)).toEqual([404]);
});
