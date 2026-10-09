// The registry rules as a pure function over "which file declares which method + path", so the
// same code checks the real routers and the deliberately broken sets the controls build.
import type { Hono } from "hono";
import { BA_ID_PARAM, UUID_PARAM } from "../../../src/shared/ids";
import type { RouteRow } from "../../../src/worker/routes/index";
import type { AppEnv } from "../../../src/worker/services/request-context";

export type DeclaredRoute = { file: string; method: string; path: string };

type Segment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string; pattern: string | null }
  | { kind: "wild" };

/** Splits on "/" outside `{…}` (a parameter pattern may contain braces, and could contain a slash). */
function split(path: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of path) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "/" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.filter((part) => part !== "");
}

export function parsePath(path: string): Segment[] {
  return split(path).map((part): Segment => {
    if (part === "*") return { kind: "wild" };
    if (part.startsWith(":")) {
      const brace = part.indexOf("{");
      const name = (brace === -1 ? part.slice(1) : part.slice(1, brace)).replace(/\?$/, "");
      const pattern = brace === -1 ? null : part.slice(brace + 1, part.lastIndexOf("}"));
      return { kind: "param", name, pattern };
    }
    return { kind: "static", value: part };
  });
}

const shape = (segments: Segment[]) =>
  "/" + segments.map((s) => (s.kind === "static" ? s.value : s.kind === "param" ? ":" : "*")).join("/");

type Claim = { method: string | null; segments: Segment[] };

function parseClaim(claim: string): Claim {
  const space = claim.indexOf(" ");
  if (space === -1) return { method: null, segments: parsePath(claim) };
  return { method: claim.slice(0, space), segments: parsePath(claim.slice(space + 1)) };
}

/** Does a declared route fall under a claim? A trailing `*` in the claim covers one or more further segments. */
function covers(claim: Claim, method: string, route: Segment[]): boolean {
  if (claim.method && method !== claim.method && method !== "ALL") return false;
  for (let i = 0; i < claim.segments.length; i += 1) {
    const want = claim.segments[i];
    const have = route[i];
    if (!want) return false;
    if (want.kind === "wild") return i === claim.segments.length - 1 && have !== undefined;
    if (!have || have.kind !== want.kind) return false;
    if (want.kind === "static" && have.kind === "static" && want.value !== have.value) return false;
  }
  return route.length === claim.segments.length;
}

function toRegExp(segments: Segment[]): RegExp {
  const body = segments
    .map((s) =>
      s.kind === "static"
        ? s.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : s.kind === "param"
          ? `(?:${s.pattern ?? "[^/]+"})`
          : ".*",
    )
    .join("/");
  return new RegExp(`^/${body}$`);
}

/** Every route a router declares, as it declared it (paths relative to /api). */
export function declared(routers: Array<{ name: string; router: Hono<AppEnv> }>): DeclaredRoute[] {
  return routers.flatMap(({ name, router }) =>
    router.routes.map((route) => ({ file: name, method: route.method, path: route.path })),
  );
}

/** The violations, as sentences. Empty when the set is sound. `routes` is in mount order. */
export function checkRegistry(routes: DeclaredRoute[], table: readonly RouteRow[]): string[] {
  const problems: string[] = [];
  const rows = new Map(table.map((row) => [row.name, row]));
  const parsed = routes.map((route) => ({ ...route, segments: parsePath(route.path) }));

  // (a) one method + path, one file.
  const owners = new Map<string, string>();
  for (const route of parsed) {
    const key = `${route.method} ${shape(route.segments)}`;
    const owner = owners.get(key);
    if (owner && owner !== route.file)
      problems.push(`duplicate: ${key} is declared by ${owner} and by ${route.file}`);
    if (!owner) owners.set(key, route.file);
  }

  for (const route of parsed) {
    const label = `${route.file}: ${route.method} ${route.path}`;

    // (b) inside the file's row.
    const row = rows.get(route.file);
    if (!row) {
      problems.push(`${label} — the file has no row in routeTable`);
    } else {
      const own = row.claims.map(parseClaim).some((claim) => covers(claim, route.method, route.segments));
      const fallback = (row.fallback ?? [])
        .map(parseClaim)
        .some((claim) => covers(claim, route.method, route.segments));
      const others = table.filter((other) => other.name !== row.name);
      const claimedElsewhere = (methodOnly: boolean) =>
        others.find((other) =>
          other.claims
            .map(parseClaim)
            .some(
              (claim) =>
                (!methodOnly || claim.method !== null) && covers(claim, route.method, route.segments),
            ),
        );
      const stronger = claimedElsewhere(true);
      const any = claimedElsewhere(false);
      if (stronger) problems.push(`${label} — outside its row: claimed by ${stronger.name}`);
      else if (own) {
        // fine
      } else if (fallback && !any) {
        // fine
      } else if (fallback && any) problems.push(`${label} — outside its row: claimed by ${any.name}`);
      else
        problems.push(
          `${label} — outside its row (may declare: ${[...row.claims, ...(row.fallback ?? [])].join(", ") || "nothing"})`,
        );
    }

    // (c) id parameters carry the right pattern.
    route.segments.forEach((segment, index) => {
      if (segment.kind !== "param") return;
      const before = shape(route.segments.slice(0, index));
      const sessionId = segment.name === "id" && before.startsWith("/account/sessions");
      if (segment.name === "userId" || sessionId) {
        if (segment.pattern !== BA_ID_PARAM) {
          problems.push(`${label} — :${segment.name} is a Better Auth id and must carry BA_ID_PARAM`);
        }
      } else if (segment.name === "id") {
        if (segment.pattern !== UUID_PARAM) problems.push(`${label} — :id must carry UUID_PARAM`);
      } else if (segment.name === "token" || segment.name.endsWith("Id")) {
        if (!segment.pattern) problems.push(`${label} — :${segment.name} has no pattern`);
      }
    });
  }

  // (d) a static path must not be capturable by an earlier parameterised route of the same method.
  parsed.forEach((later, index) => {
    if (!later.segments.every((segment) => segment.kind === "static")) return;
    const path = shape(later.segments);
    for (const earlier of parsed.slice(0, index)) {
      const hasParam = earlier.segments.some((segment) => segment.kind === "param");
      const hasWild = earlier.segments.some((segment) => segment.kind === "wild");
      if (!hasParam || hasWild) continue;
      if (earlier.method !== later.method && earlier.method !== "ALL") continue;
      if (toRegExp(earlier.segments).test(path)) {
        problems.push(
          `shadowed: ${later.file}: ${later.method} ${later.path} is captured by the earlier ${earlier.file}: ${earlier.method} ${earlier.path}`,
        );
      }
    }
  });

  return problems;
}
