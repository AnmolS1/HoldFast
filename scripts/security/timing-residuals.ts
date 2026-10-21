// Response-time distributions of the timing residuals accepted in Wave 2 (T26 item 17): for each
// kind, n requests from the same caller, INTERLEAVED round-robin across the kinds of a group, then
// n / p50 / p95 / min / max per kind and, against the group's first kind, the probability that a
// request of that kind is slower (0.5 = indistinguishable).
//
//   seed     writes the rows each kind needs (DATABASE_URL_DIRECT; never production) and a kinds
//            file (mode 600, outside the repository)
//   measure  sends the requests and prints the table; for files404 it mints the URLs AS the
//            session's user while each node is visible and then puts the node in its state, in
//            blocks that fit a download token's 300 s (so it needs DATABASE_URL_DIRECT too)
//
//   npx tsx scripts/security/timing-residuals.ts seed --base <app> --session owner.json \
//       --out "$DIR/kinds.json" [--n 200] [--non-prod-host <db host>]
//   npx tsx scripts/security/timing-residuals.ts measure --base <app> --files <files origin> \
//       --session owner.json --kinds "$DIR/kinds.json" [--peer-session peer.json] \
//       [--groups files404,api404,delete,init,complete] [--n 200] [--rate-api 8] [--rate-files 4] [--local]
//
// Groups (the residuals of T26 item 17 and the brief's additions):
//   files404  files host, every kind of 404 for the URL's own user: a replaced version, trashed,
//             taken down, in a trashed folder, in a taken-down folder — and, as its own kind, a file
//             under a HELD folder (standing check (b): it is served, so its answer differs; listed to
//             show what holding does to the time)
//   api404    GET /api/nodes/:id as a non-owner: unknown, no share, taken down, trashed, not visible
//             (infected), in a trashed folder, in a taken-down folder; and a visible one (200)
//   delete    DELETE /nodes/:id on a trashed root: a held folder, a folder not held (one file each),
//             and a file trashed on its own under a held folder (T14 m10; standing check (b))
//   init      POST /api/uploads: this account (which holds purge-requested held trees once `delete`
//             has run) vs --peer-session's account, which holds none (T23 d3)
//   complete  upload complete of a small file whose declared hash is LISTED vs one that is merely
//             wrong (T12 Addendum 8 (1)); the bytes are never the listed ones
//
// Rates: the limits are RL_API 600/60 s per user and RL_FILES 300/60 s per address; the defaults
// stay under them. A 429 stops the run. Nothing secret is printed.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateId } from "@better-auth/core/utils/id";
import pg from "pg";
import { uuidv7 } from "../../src/worker/db/ids";
import { extOf, nameKeyOf } from "../../src/worker/services/filename";
import { classifyTarget, outsideRepo } from "../lib/session-target";

/** src/worker/services/storage.ts `keyFor`, written out (that module needs the Worker's types). */
const keyFor = (ownerId: string, nodeId: string, versionId: string) => `u/${ownerId}/${nodeId}/${versionId}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    files: { type: "string" },
    session: { type: "string" },
    "peer-session": { type: "string" },
    kinds: { type: "string" },
    out: { type: "string" },
    n: { type: "string", default: "200" },
    groups: { type: "string", default: "files404,api404,delete,init,complete" },
    "rate-api": { type: "string", default: "8" },
    "rate-files": { type: "string", default: "4" },
    "non-prod-host": { type: "string" },
    local: { type: "boolean", default: false },
  },
});

type Session = { header: string; user: { id: string } };
type Kinds = {
  base: string;
  ownerId: string;
  /** The file each kind requests, and the node whose state makes it that kind (applied after minting). */
  files404: Record<
    string,
    { node: string; target: string; state: "replaced" | "trashed" | "taken down" | "none" }
  >;
  api404: Record<string, string>;
  /** Trashed roots: held folders, folders not held, and files whose (untrashed) folder is held. */
  delete: { held: string[]; unheld: string[]; inherited: string[] };
  listedSha256: string;
};

const fail = (message: string): never => {
  console.error(`timing-residuals: ${message}`);
  process.exit(2);
};
const command = positionals[0];
if (command !== "seed" && command !== "measure")
  fail("usage: timing-residuals.ts seed|measure … (see the header)");
if (!values.base) fail("--base is required");
if (!values.session) fail("--session is required");
const base = new URL(values.base!).origin;
const n = Number(values.n);
if (!Number.isInteger(n) || n < 1) fail("--n must be a whole number");
const session = JSON.parse(readFileSync(values.session!, "utf8")) as Session;
if (!session.header || !session.user?.id) fail("the session file has no header or user id");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (count: number) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(count)),
    (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
  ).join("");
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** One pacer per host: at most `rate` requests a second. */
function pacer(rate: number) {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    next = Math.max(Date.now(), next) + 1000 / rate;
  };
}
const apiPace = pacer(Number(values["rate-api"]));
const filesPace = pacer(Number(values["rate-files"]));

function api(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown; body?: Uint8Array } = {},
) {
  const headers: Record<string, string> = { cookie, origin: base, "sec-fetch-site": "same-origin" };
  let body: RequestInit["body"];
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.body) {
    headers["content-type"] = "application/octet-stream";
    body = init.body;
  }
  return fetch(`${base}/api${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
}

// ── seed ───────────────────────────────────────────────────────────────────────────────────────

async function seed() {
  const target = classifyTarget(process.env.DATABASE_URL_DIRECT, { nonProdHost: values["non-prod-host"] });
  if (target.target === "prod") fail("never against production");
  if (!values.out) fail("--out is required");
  const out = outsideRepo(values.out!);
  const owner = session.user.id;
  const cookie = session.header;

  const kinds: Kinds = {
    base,
    ownerId: owner,
    files404: {},
    api404: {},
    delete: { held: [], unheld: [], inherited: [] },
    listedSha256: hex(crypto.getRandomValues(new Uint8Array(32))),
  };

  const db = new pg.Client({ connectionString: target.url });
  await db.connect();
  try {
    const folder = async (ownerId: string, parentId: string | null, name: string) => {
      const id = uuidv7();
      await db.query(
        `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, scan_status)
         VALUES ($1, $2, $2, $3, 'folder', $4, $5, 'clean')`,
        [id, ownerId, parentId, name, nameKeyOf(name)],
      );
      return id;
    };
    const file = async (ownerId: string, parentId: string | null, scanStatus = "clean") => {
      const id = uuidv7();
      const versionId = uuidv7();
      const name = `timing-${rand(8)}.bin`;
      await db.query(
        `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, r2_key, version_id, scan_status)
         VALUES ($1, $2, $2, $3, 'file', $4, $5, $6, 100, $7, $8, $9)`,
        [
          id,
          ownerId,
          parentId,
          name,
          nameKeyOf(name),
          extOf(name),
          keyFor(ownerId, id, versionId),
          versionId,
          scanStatus,
        ],
      );
      return id;
    };
    const set = (sqlSet: string, ids: string[]) =>
      db.query(`UPDATE nodes SET ${sqlSet} WHERE id = ANY($1::uuid[])`, [ids]);
    const TRASH = "deleted_at = now(), trashed_root = true";
    const TAKEDOWN = "takedown_at = now(), takedown_reason = 'admin'";

    // Another account, whose tree is shared with the caller (made up: it never signs in).
    const other = generateId(32);
    await db.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Timing Peer', $2, true, now(), now())`,
      [other, `remote-spec-timing-${rand(8)}@holdfast-timing.example`],
    );
    const shared = await folder(other, null, `timing shared ${rand(4)}`);
    await db.query(
      `INSERT INTO shares (id, node_id, granted_by, grantee_email, grantee_user_id, activated_at, role)
       VALUES ($1, $2, $3, $4, $5, now(), 'viewer')`,
      [uuidv7(), shared, other, `timing-${rand(6)}@holdfast-timing.example`, owner],
    );
    const sharedTrashed = await folder(other, shared, "trashed folder");
    const sharedDown = await folder(other, shared, "taken-down folder");
    const otherDown = await file(other, shared);
    const otherTrashed = await file(other, shared);
    kinds.api404 = {
      unknown: uuidv7(),
      "no share": await file(other, null),
      "taken down": otherDown,
      trashed: otherTrashed,
      "not visible (infected)": await file(other, shared, "infected"),
      "in a trashed folder": await file(other, sharedTrashed),
      "in a taken-down folder": await file(other, sharedDown),
      "visible (200)": await file(other, shared),
    };
    await set(TAKEDOWN, [otherDown, sharedDown]);
    await set(TRASH, [otherTrashed, sharedTrashed]);

    // The caller's own files, each minted while it was visible, then put in its state.
    const own = await folder(owner, null, `timing own ${rand(4)}`);
    const ownTrashed = await folder(owner, own, "trashed folder");
    const ownDown = await folder(owner, own, "taken-down folder");
    const ownHeld = await folder(owner, own, "held folder");
    const replaced = await file(owner, own);
    const trashed = await file(owner, own);
    const down = await file(owner, own);
    kinds.files404 = {
      "a replaced version": { node: replaced, target: replaced, state: "replaced" },
      trashed: { node: trashed, target: trashed, state: "trashed" },
      "taken down": { node: down, target: down, state: "taken down" },
      "in a trashed folder": { node: await file(owner, ownTrashed), target: ownTrashed, state: "trashed" },
      "in a taken-down folder": { node: await file(owner, ownDown), target: ownDown, state: "taken down" },
      "under a held folder": { node: await file(owner, ownHeld), target: ownHeld, state: "none" },
    };
    // The URLs are minted by `measure`, block by block (a download token lives 300 s).
    await set("legal_hold = true", [ownHeld]);

    // DELETE: n trashed folders of one file each, held and not held. Trashed through the API (the
    // route's own bookkeeping); the hold set after, as an admin would.
    for (const held of [true, false]) {
      for (let i = 0; i < n; i++) {
        const id = await folder(owner, null, `timing delete ${held ? "held" : "free"} ${rand(6)}`);
        await file(owner, id);
        (held ? kinds.delete.held : kinds.delete.unheld).push(id);
      }
    }
    // Standing check (b): a file trashed on its own, under a folder that is held (inherited hold).
    const heldParents: string[] = [];
    for (let i = 0; i < n; i++) {
      const parent = await folder(owner, null, `timing delete parent ${rand(6)}`);
      heldParents.push(parent);
      kinds.delete.inherited.push(await file(owner, parent));
    }
    for (const id of [...kinds.delete.held, ...kinds.delete.unheld, ...kinds.delete.inherited]) {
      await apiPace();
      const answer = await api(cookie, `/nodes/${id}/trash`, { method: "POST" });
      if (!answer.ok) fail(`trashing a delete-group node: ${answer.status}`);
      await answer.arrayBuffer();
    }
    if (n > 0) await set("legal_hold = true", [...kinds.delete.held, ...heldParents]);

    // The listed hash of the `complete` group: made up, so nobody's bytes can have it.
    await db.query("INSERT INTO hash_blocklist (sha256, reason) VALUES ($1, 'admin')", [kinds.listedSha256]);
  } finally {
    await db.end();
  }

  writeFileSync(out, `${JSON.stringify(kinds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(
    `timing-residuals: seeded (${target.target}) files404 ${Object.keys(kinds.files404).length} kinds, api404 ` +
      `${Object.keys(kinds.api404).length} kinds, delete ${n}+${n}+${n} roots; the kinds file is at --out (mode 600)`,
  );
}

// ── measure ────────────────────────────────────────────────────────────────────────────────────

type Sample = { ms: number; status: number };
type Kind = { name: string; once: (round: number) => Promise<Sample> };

async function timed(run: () => Promise<Response>, read?: (body: ArrayBuffer) => void): Promise<Sample> {
  const started = performance.now();
  const response = await run();
  const body = await response.arrayBuffer();
  read?.(body);
  const ms = performance.now() - started;
  if (response.status === 429) {
    const code = /"error":"([a-z_]+)"/.exec(new TextDecoder().decode(body))?.[1] ?? "text";
    fail(
      `429 (${code}) from the server — nothing more is sent (rate_limited: lower --rate-api / --rate-files)`,
    );
  }
  return { ms, status: response.status };
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** P(a random sample of `b` is slower than one of `a`), ties counted half. 0.5 = no difference. */
function superiority(a: number[], b: number[]): number {
  let wins = 0;
  for (const x of a) for (const y of b) wins += y > x ? 1 : y === x ? 0.5 : 0;
  return wins / (a.length * b.length);
}

async function runGroup(name: string, kinds: Kind[], rounds: number) {
  const samples = new Map<string, Sample[]>(kinds.map((kind) => [kind.name, []]));
  for (let round = 0; round < rounds; round++) {
    // Round-robin, starting from a different kind every round.
    for (let k = 0; k < kinds.length; k++) {
      const kind = kinds[(k + round) % kinds.length]!;
      samples.get(kind.name)!.push(await kind.once(round));
    }
  }
  const first = samples.get(kinds[0]!.name)!.map((s) => s.ms);
  console.log(`\n${name}`);
  console.log(
    "  kind                                n     p50 ms   p95 ms   min ms   max ms  statuses        P(slower than first)",
  );
  for (const [kind, list] of samples) {
    const ms = list.map((s) => s.ms).sort((x, y) => x - y);
    const statuses = [...new Set(list.map((s) => s.status))].join(",");
    console.log(
      `  ${kind.padEnd(34)} ${String(ms.length).padStart(4)} ${quantile(ms, 0.5).toFixed(1).padStart(9)} ${quantile(
        ms,
        0.95,
      )
        .toFixed(1)
        .padStart(
          8,
        )} ${ms[0]!.toFixed(1).padStart(8)} ${ms[ms.length - 1]!.toFixed(1).padStart(8)}  ${statuses.padEnd(14)} ${superiority(first, ms).toFixed(2)}`,
    );
  }
}

async function measure() {
  if (!values.kinds) fail("--kinds is required");
  const kinds = JSON.parse(readFileSync(values.kinds!, "utf8")) as Kinds;
  const files = values.files ? new URL(values.files).origin : fail("--files is required");
  const cookie = session.header;
  const groups = new Set(values.groups!.split(","));
  const local = values.local === true;
  if (local && !/^(localhost|127\.0\.0\.1)$/.test(new URL(base).hostname))
    fail("--local is for vite dev only");
  console.log(
    `timing-residuals: ${base} — n=${n} per kind, interleaved; ${local ? "LOCAL (not evidence)" : "remote"}`,
  );

  const filesGet = async (path: string) => {
    if (!local) return fetch(`${files}${path}`);
    // `vite dev` listens on 127.0.0.1 only; files.localhost resolves to ::1 (see ratelimit-probe.ts).
    const target = new URL(files);
    const { request } = await import("node:http");
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: target.port, path, headers: { host: target.host } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
        },
      );
      req.on("error", reject);
      req.end();
    });
  };

  if (groups.has("files404")) {
    // A download token lives 300 s (TOKEN_TTL.download): the URLs are minted per block of rounds
    // that fits in 240 s — each node made visible, minted for, then put back in its state.
    const target = classifyTarget(process.env.DATABASE_URL_DIRECT, { nonProdHost: values["non-prod-host"] });
    if (target.target === "prod") fail("never against production");
    const db = new pg.Client({ connectionString: target.url });
    await db.connect();
    const entries = Object.entries(kinds.files404);
    const perBlock = Math.max(1, Math.floor((240 * Number(values["rate-files"])) / entries.length));
    const paths = new Map<string, string>();
    const mintBlock = async () => {
      for (const [kind, { node, target: stateNode, state }] of entries) {
        if (state === "trashed")
          await db.query("UPDATE nodes SET deleted_at = NULL, trashed_root = false WHERE id = $1", [
            stateNode,
          ]);
        if (state === "taken down")
          await db.query("UPDATE nodes SET takedown_at = NULL, takedown_reason = NULL WHERE id = $1", [
            stateNode,
          ]);
        await apiPace();
        const minted = await api(cookie, `/nodes/${node}/download-url`, { json: { kind: "download" } });
        if (!minted.ok) fail(`minting a URL for "${kind}": ${minted.status}`);
        paths.set(kind, new URL(((await minted.json()) as { url: string }).url).pathname);
        if (state === "replaced")
          await db.query("UPDATE nodes SET version_id = $2 WHERE id = $1", [stateNode, uuidv7()]);
        if (state === "trashed")
          await db.query("UPDATE nodes SET deleted_at = now(), trashed_root = true WHERE id = $1", [
            stateNode,
          ]);
        if (state === "taken down")
          await db.query("UPDATE nodes SET takedown_at = now(), takedown_reason = 'admin' WHERE id = $1", [
            stateNode,
          ]);
      }
    };
    try {
      await runGroup(
        "files host: every kind of 404 (T13 M1), and a file under a held folder",
        entries.map(([name]) => ({
          name,
          once: async (round: number) => {
            if (round % perBlock === 0 && name === entries[round % entries.length]![0]) await mintBlock();
            // The wait is outside the timed part.
            await filesPace();
            return timed(() => filesGet(paths.get(name)!));
          },
        })),
        n,
      );
    } finally {
      await db.end();
    }
  }
  if (groups.has("api404")) {
    await runGroup(
      "API: GET /nodes/:id, every kind of 404 (permission-matrix) and a visible one",
      Object.entries(kinds.api404).map(([name, id]) => ({
        name,
        once: async () => {
          await apiPace();
          return timed(() => api(cookie, `/nodes/${id}`));
        },
      })),
      n,
    );
  }
  if (groups.has("delete")) {
    const rounds = Math.min(
      n,
      kinds.delete.held.length,
      kinds.delete.unheld.length,
      kinds.delete.inherited.length,
    );
    const label = { held: "held folder", unheld: "folder not held", inherited: "file under a held folder" };
    await runGroup(
      "DELETE /nodes/:id on a trashed root: held vs not held (T14 m10; not equalised by ruling)",
      (["held", "unheld", "inherited"] as const).map((which) => ({
        name: label[which],
        once: async (round: number) => {
          await apiPace();
          return timed(() => api(cookie, `/nodes/${kinds.delete[which][round]}`, { method: "DELETE" }));
        },
      })),
      rounds,
    );
  }
  if (groups.has("init")) {
    if (!values["peer-session"])
      console.log("\ninit: skipped — needs --peer-session (an account with no held tree)");
    else {
      const peer = (JSON.parse(readFileSync(values["peer-session"], "utf8")) as Session).header;
      const init = (who: string) => async () => {
        await apiPace();
        let uploadId: string | undefined;
        const sample = await timed(
          () =>
            api(who, "/uploads", {
              json: {
                parentId: null,
                name: `timing-init-${rand(10)}.bin`,
                size: 1,
                mimeDeclared: "application/octet-stream",
                fileLastModified: new Date().toISOString(),
                onConflict: "rename",
                purpose: "file",
              },
            }),
          (body) => {
            uploadId = (JSON.parse(new TextDecoder().decode(body)) as { uploadId?: string }).uploadId;
          },
        );
        // Given up at once, outside the timed part: an account may hold only so many open uploads.
        if (uploadId) {
          await apiPace();
          const aborted = await api(who, `/uploads/${uploadId}`, { method: "DELETE" });
          await aborted.arrayBuffer();
        }
        return sample;
      };
      await runGroup(
        "POST /uploads (init): an account holding purge-requested held trees vs one holding none (T23 d3)",
        [
          { name: "this account (held trees)", once: init(cookie) },
          { name: "peer account (none)", once: init(peer) },
        ],
        n,
      );
    }
  }
  if (groups.has("complete")) {
    const complete = (declared: () => string) => async () => {
      const bytes = crypto.getRandomValues(new Uint8Array(1000));
      await apiPace();
      const init = await api(cookie, "/uploads", {
        json: {
          parentId: null,
          name: `timing-complete-${rand(10)}.bin`,
          size: bytes.byteLength,
          mimeDeclared: "application/octet-stream",
          fileLastModified: new Date().toISOString(),
          onConflict: "rename",
          purpose: "file",
        },
      });
      if (!init.ok) fail(`complete group: init ${init.status}`);
      const { uploadId } = (await init.json()) as { uploadId: string };
      await apiPace();
      const put = await api(cookie, `/uploads/${uploadId}/single`, { method: "PUT", body: bytes });
      if (!put.ok) fail(`complete group: put ${put.status}`);
      await put.arrayBuffer();
      await apiPace();
      return timed(() =>
        api(cookie, `/uploads/${uploadId}/complete`, { json: { sha256: declared(), parts: [] } }),
      );
    };
    await runGroup(
      "upload complete, 1000 bytes: declared hash LISTED vs merely wrong (T12 Addendum 8 (1))",
      [
        { name: "declared hash listed", once: complete(() => kinds.listedSha256) },
        {
          name: "declared hash wrong, unlisted",
          once: complete(() => hex(crypto.getRandomValues(new Uint8Array(32)))),
        },
      ],
      n,
    );
  }
}

(command === "seed" ? seed() : measure()).catch((error: unknown) => {
  console.error(`timing-residuals: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
