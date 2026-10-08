// Build stamp: GET /__meta → { project, commit, branch, builtAt, version }, never cached.
// The four constants are injected by `define` in vite.config.ts. Under a runner that does not
// define them (a unit test, say) the stamp reports "unknown" instead of throwing.

declare const __GIT_SHA__: string | undefined;
declare const __GIT_BRANCH__: string | undefined;
declare const __BUILT_AT__: string | undefined;
declare const __APP_VERSION__: string | undefined;

export interface BuildMeta {
  project: "holdfast";
  commit: string;
  branch: string;
  builtAt: string;
  version: string;
}

export function buildMeta(): BuildMeta {
  return {
    project: "holdfast",
    commit: typeof __GIT_SHA__ === "string" ? __GIT_SHA__ : "unknown",
    branch: typeof __GIT_BRANCH__ === "string" ? __GIT_BRANCH__ : "unknown",
    builtAt: typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : "unknown",
    version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
  };
}

export function metaResponse(): Response {
  return Response.json(buildMeta(), { headers: { "cache-control": "no-store" } });
}
