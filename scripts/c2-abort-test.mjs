#!/usr/bin/env node
// C2 — Better Auth issue #10315 (an isolate hangs after an aborted request). Plain Node, no
// dependencies. Two modes:
//
//   node scripts/c2-abort-test.mjs <baseUrl> [--rounds 3] [--gap 61]
//       THE ABORT TEST — supplementary evidence, against a DEPLOY only (the dev deploy right
//       after a deploy; prod at the go-live gate). Each round: 10 concurrent requests — a mix of
//       POST /api/auth/sign-in/email and GET /api/auth/get-session — each aborted by the client
//       after 1, 5, 20, 50 or 100 ms; then 20 × GET /api/auth/get-session (10 one after another,
//       10 at once). EVERY follow-up must answer within 2 s. Rounds are 61 s apart so each stays
//       inside the per-minute limiters. Exit 1 on any timeout or any 5xx. A 429 is an answer,
//       not a failure: the session middleware (which calls Better Auth) runs before the limiter.
//
//       WHAT IT CAN AND CANNOT SHOW. It passed on the UNMITIGATED build as well (spike P2), so
//       in the Worker's present shape it cannot fail; it bites only if the import shape changes
//       (a lazily loaded chunk that evaluates Better Auth inside a request, an instance cached
//       on the isolate) or a new cached promise appears. A pass is NOT proof of the mitigation —
//       the proof is the storage-identity test (tests/unit/auth/c2-preseed.test.ts) and its
//       mutant control.
//
//       AGAINST A LOCAL SERVER IT CANNOT FAIL UNDER ANY CIRCUMSTANCES: local workerd (`vite dev`,
//       `wrangler dev`) runs an aborted request to completion. So a localhost URL is refused
//       unless --allow-local is given, and then the result is labelled as not being evidence.
//
//   node scripts/c2-abort-test.mjs --static [--dist dist/holdfast_dev]
//       THE TWO STATIC GUARDS, from files on disk (run `npm run build` first):
//       1. drift guard — the installed @better-auth/core still creates its three storages the
//          way src/worker/auth/als-preseed.ts assumes (same global symbol, same three keys, an
//          existing storage returned BEFORE the loader is awaited). (The same assertions also
//          run inside `npm test`, in the Workers project.)
//       2. static-import guard — in the built Worker bundle the pre-seed and Better Auth's
//          loader are evaluated at start-up, the pre-seed first, and no dynamically imported
//          chunk brings in the loader or the storage modules.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const STORAGE_KEYS = ["requestStateAsyncStorage", "adapterAsyncStorage", "endpointContextAsyncStorage"];
const LOADER = "AsyncLocalStoragePromise";

// ── --static ────────────────────────────────────────────────────────────────────────────────

function staticGuards() {
  const problems = [];
  const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${message}`);
    if (!ok) problems.push(message);
  };

  console.log("drift guard: node_modules/@better-auth/core");
  const core = join(root, "node_modules/@better-auth/core/dist");
  const read = (path) => readFileSync(join(core, path), "utf8");
  const version = JSON.parse(
    readFileSync(join(root, "node_modules/@better-auth/core/package.json"), "utf8"),
  ).version;
  check(
    version === "1.7.7",
    `@better-auth/core is ${version} (the pre-seed was derived from 1.7.7 — re-derive it on any other)`,
  );
  const global = read("context/global.mjs");
  check(
    global.includes('Symbol.for("better-auth:global")'),
    'global.mjs keeps its bag under Symbol.for("better-auth:global")',
  );
  check(/globalThis\[symbol\]\s*=\s*\{[^}]*context:/s.test(global), "the bag has a `context` object");
  const loader = read("async_hooks/index.mjs");
  check(
    /const AsyncLocalStoragePromise = import\(/.test(loader),
    "the loader is still a module-scope promise (the defect is still there)",
  );
  for (const [file, key] of [
    ["context/request-state.mjs", STORAGE_KEYS[0]],
    ["context/transaction.mjs", STORAGE_KEYS[1]],
    ["context/endpoint-context.mjs", STORAGE_KEYS[2]],
  ]) {
    const source = read(file);
    const readAt = source.indexOf(`context.${key}`);
    const returnAt = source.indexOf("if (existing) return existing;");
    const awaitAt = source.indexOf("await getAsyncLocalStorage()");
    check(readAt !== -1, `${file} reads context.${key}`);
    check(
      returnAt > readAt && awaitAt > returnAt,
      `${file} returns an existing storage before it awaits the loader`,
    );
  }
  const preseed = readFileSync(join(root, "src/worker/auth/als-preseed.ts"), "utf8");
  for (const key of STORAGE_KEYS)
    check(preseed.includes(`${key}: new AsyncLocalStorage()`), `als-preseed.ts seeds ${key}`);
  const createAuth = readFileSync(join(root, "src/worker/auth/create-auth.ts"), "utf8");
  check(
    createAuth.trimStart().startsWith('import "./als-preseed";'),
    'create-auth.ts starts with `import "./als-preseed";`',
  );
  const entry = readFileSync(join(root, "src/worker/index.ts"), "utf8");
  const firstImport = /^import [^;]*;/m.exec(entry)?.[0] ?? "";
  check(
    firstImport.includes('"./auth/create-auth"'),
    "the Worker entry's first import is ./auth/create-auth",
  );

  console.log("\nstatic-import guard: the built Worker bundle");
  const dist = resolve(root, option("--dist", "dist/holdfast_dev"));
  const entryFile = join(dist, "index.js");
  if (!existsSync(entryFile)) {
    check(false, `${relative(root, entryFile)} exists (run \`npm run build\` first)`);
    return problems;
  }
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".js") || name.endsWith(".mjs")) files.set(path, readFileSync(path, "utf8"));
    }
  };
  walk(dist);
  const local = (from, specifier) => (specifier.startsWith(".") ? resolve(dirname(from), specifier) : null);
  const staticImports = (path) => {
    const source = files.get(path) ?? "";
    const found = new Set();
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm))
      found.add(match[1]);
    for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.add(match[1]);
    return [...found].map((s) => local(path, s)).filter((p) => p && files.has(p));
  };
  const dynamicImports = (path) => {
    const source = files.get(path) ?? "";
    return [...source.matchAll(/\bimport\(\s*(?:\/\*[\s\S]*?\*\/\s*)*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1],
    );
  };
  const closure = (start) => {
    const seen = new Set();
    const stack = [...start];
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...staticImports(next));
    }
    return seen;
  };
  const startup = closure([entryFile]);
  const names = (set) => [...set].map((p) => relative(dist, p)).sort();
  console.log(`      evaluated at start-up (static closure of index.js): ${names(startup).join(", ")}`);

  const has = (path, text) => (files.get(path) ?? "").includes(text);
  const withLoader = [...files.keys()].filter((p) => has(p, `${LOADER} = import(`));
  const withPreseed = [...files.keys()].filter((p) =>
    has(p, "requestStateAsyncStorage: new AsyncLocalStorage()"),
  );
  check(
    withLoader.length === 1,
    `Better Auth's loader is in exactly one chunk (${names(new Set(withLoader)).join(", ") || "none"})`,
  );
  check(
    withPreseed.length === 1,
    `the pre-seed is in exactly one chunk (${names(new Set(withPreseed)).join(", ") || "none"})`,
  );
  check(
    withLoader.every((p) => startup.has(p)),
    "the loader's chunk is evaluated at start-up, not inside a request",
  );
  check(
    withPreseed.every((p) => startup.has(p)),
    "the pre-seed's chunk is evaluated at start-up",
  );
  if (withLoader.length === 1 && withPreseed.length === 1) {
    if (withLoader[0] === withPreseed[0]) {
      const source = files.get(withLoader[0]);
      check(
        source.indexOf("requestStateAsyncStorage: new AsyncLocalStorage()") <
          source.indexOf(`${LOADER} = import(`),
        "within that chunk the pre-seed comes before the loader",
      );
    } else {
      // Another chunk: it must be one the loader's chunk imports statically (so it runs first).
      check(
        closure([withLoader[0]]).has(withPreseed[0]),
        "the pre-seed's chunk is a static import of the loader's chunk (it runs first)",
      );
    }
  }

  // Every dynamic import in the start-up code, and what it would bring in that is not loaded yet.
  const sensitive = [LOADER, ...STORAGE_KEYS.map((key) => `context.${key}`)];
  for (const from of startup) {
    for (const specifier of dynamicImports(from)) {
      const target = local(from, specifier);
      if (!target) {
        // A platform module (node:async_hooks — the loader itself —, cloudflare:sockets): no code of ours.
        console.log(`      dynamic import of ${specifier} (a runtime module) in ${relative(dist, from)}`);
        continue;
      }
      const brings = [...closure([target])].filter((p) => !startup.has(p));
      const offending = brings.filter((p) => sensitive.some((text) => has(p, text)));
      check(
        offending.length === 0,
        `lazy chunk ${relative(dist, target)} brings in no Better Auth loader or storage module` +
          (offending.length
            ? ` — but ${names(new Set(offending)).join(", ")} does`
            : ` (it adds: ${names(new Set(brings)).join(", ") || "nothing"})`),
      );
    }
  }
  return problems;
}

// ── the abort test ──────────────────────────────────────────────────────────────────────────

const ABORT_DELAYS_MS = [1, 5, 20, 50, 100];
const FOLLOW_UP_TIMEOUT_MS = 2_000;

function isLocal(url) {
  return (
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) || url.hostname.endsWith(".localhost")
  );
}

async function aborted(base, index) {
  const controller = new AbortController();
  const delay = ABORT_DELAYS_MS[index % ABORT_DELAYS_MS.length];
  const timer = setTimeout(() => controller.abort(), delay);
  const post = index % 2 === 0;
  const started = Date.now();
  try {
    const response = await fetch(new URL(post ? "/api/auth/sign-in/email" : "/api/auth/get-session", base), {
      method: post ? "POST" : "GET",
      headers: post ? { "content-type": "application/json", origin: base.origin } : {},
      // No captcha token: the request still travels the Worker's whole pipeline into Better Auth.
      body: post
        ? JSON.stringify({
            email: `c2-${Date.now()}-${index}@example.invalid`,
            password: "not a real password",
          })
        : undefined,
      signal: controller.signal,
    });
    await response.arrayBuffer().catch(() => {});
    return { kind: "answered-before-abort", status: response.status, delay, ms: Date.now() - started };
  } catch {
    return { kind: "aborted", delay, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function followUp(base, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FOLLOW_UP_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(new URL("/api/auth/get-session", base), { signal: controller.signal });
    await response.arrayBuffer();
    return { label, status: response.status, ms: Date.now() - started };
  } catch (error) {
    const ms = Date.now() - started;
    return {
      label,
      status:
        ms >= FOLLOW_UP_TIMEOUT_MS - 50
          ? "TIMEOUT"
          : `ERROR ${error?.cause?.code ?? error?.name ?? "fetch failed"}`,
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function round(base, number) {
  console.log(`\nround ${number}: 10 concurrent requests, each aborted by the client`);
  const firsts = await Promise.all(Array.from({ length: 10 }, (_, index) => aborted(base, index)));
  for (const first of firsts) {
    console.log(
      `  abort after ${String(first.delay).padStart(3)} ms → ${first.kind}${first.status ? ` (${first.status})` : ""} in ${first.ms} ms`,
    );
  }
  const results = [];
  for (let i = 1; i <= 10; i++) results.push(await followUp(base, `sequential ${i}`));
  results.push(
    ...(await Promise.all(Array.from({ length: 10 }, (_, i) => followUp(base, `concurrent ${i + 1}`)))),
  );
  for (const result of results)
    console.log(
      `  follow-up ${result.label.padEnd(13)} → ${String(result.status).padEnd(8)} ${result.ms} ms`,
    );
  return results;
}

async function abortTest(baseArgument) {
  const base = new URL(baseArgument);
  const local = isLocal(base);
  if (local && !flag("--allow-local")) {
    console.error(
      `c2-abort-test: ${base.host} is a local server. Local workerd runs an aborted request to completion, so this\n` +
        "test CANNOT fail there and a pass is not evidence of anything. Run it against the dev deploy right after a\n" +
        "deploy. (--allow-local runs it anyway, to check that the script itself works.)",
    );
    return 2;
  }
  const rounds = Number(option("--rounds", "3"));
  const gapSeconds = Number(option("--gap", "61"));
  console.log(
    `c2-abort-test against ${base.origin}: ${rounds} round(s), ${gapSeconds} s apart, follow-up limit ${FOLLOW_UP_TIMEOUT_MS} ms`,
  );
  if (local) console.log("NOTE: a local server — this run is NOT evidence (it cannot fail here).");

  const all = [];
  for (let number = 1; number <= rounds; number++) {
    if (number > 1) {
      console.log(`\nwaiting ${gapSeconds} s (the per-minute limiters) …`);
      await new Promise((done) => setTimeout(done, gapSeconds * 1000));
    }
    all.push(...(await round(base, number)));
  }

  const histogram = {};
  for (const result of all) histogram[result.status] = (histogram[result.status] ?? 0) + 1;
  const times = all.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    `\nfollow-ups: ${all.length}; statuses ${JSON.stringify(histogram)}; ms min ${times[0]} / median ${times[Math.floor(times.length / 2)]} / max ${times.at(-1)}`,
  );
  const failures = all.filter((r) => typeof r.status !== "number" || r.status >= 500);
  if (failures.length > 0) {
    console.error(
      `FAIL: ${failures.length} follow-up(s) timed out, errored or answered 5xx — on a deploy this is a real hang and blocks the gate.`,
    );
    return 1;
  }
  console.log(
    local
      ? "pass — but against a local server, which proves nothing (see the note above)."
      : "pass: every follow-up answered within 2 s. Supplementary evidence only — this test also passed without the mitigation.",
  );
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

if (flag("--static")) {
  const problems = staticGuards();
  console.log(problems.length === 0 ? "\nstatic guards: pass" : `\nstatic guards: ${problems.length} FAILED`);
  process.exit(problems.length === 0 ? 0 : 1);
} else {
  const base = args.find((arg) => /^https?:\/\//.test(arg));
  if (!base) {
    console.error(
      "usage: node scripts/c2-abort-test.mjs <baseUrl> [--rounds 3] [--gap 61] [--allow-local]\n       node scripts/c2-abort-test.mjs --static [--dist dist/holdfast_dev]",
    );
    process.exit(2);
  }
  process.exit(await abortTest(base));
}
