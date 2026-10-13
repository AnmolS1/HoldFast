// What every answer of the files host carries, and what none ever does: the fixed hardened set on
// every response, a file's own headers on top, never a cookie, never HTML.
import { describe, expect, it } from "vitest";
import {
  ask,
  imagesMock,
  linkOn,
  makeAccount,
  pattern,
  rand,
  signRaw,
  storedFile,
  TEST_APP_ORIGIN,
  urlFor,
  type Answer,
} from "./harness";

const FIXED: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "access-control-allow-origin": TEST_APP_ORIGIN,
  vary: "Origin",
};

function expectFixed(answer: Answer, label: string) {
  for (const [name, value] of Object.entries(FIXED))
    expect(answer.headers.get(name), `${label} ${name}`).toBe(value);
  expect(answer.headers.get("set-cookie"), label).toBeNull();
  expect(answer.headers.get("content-type") ?? "", label).not.toMatch(/html|json/i);
}

/** Every header of an answer but the ones that differ per object or per response. */
function snapshot(answer: Answer): Record<string, string> {
  const out: Record<string, string> = {};
  answer.headers.forEach((value, name) => {
    out[name] = name === "etag" || name === "last-modified" ? "<validator>" : value;
  });
  return out;
}

describe("headers", () => {
  it("the snapshot of each route: the fixed set plus the file's own, and nothing else", async () => {
    const owner = await makeAccount();
    const { node } = await storedFile(owner.id, {
      mime: "image/png",
      name: "holiday photo.png",
      content: pattern(700),
    });
    const env = { IMAGES: imagesMock().binding };
    const own = {
      "accept-ranges": "bytes",
      "access-control-expose-headers":
        "Content-Length, Content-Range, ETag, Accept-Ranges, X-Holdfast-Warning",
      etag: "<validator>",
      "last-modified": "<validator>",
    };
    const name = `filename="holiday photo.png"; filename*=UTF-8''holiday%20photo.png`;

    const download = await ask(await urlFor("download", node, { user: owner.id }));
    expect(snapshot(download)).toEqual({
      ...FIXED,
      ...own,
      "content-type": "image/png",
      "content-length": "700",
      "content-disposition": `attachment; ${name}`,
    });

    const inline = await ask(await urlFor("inline", node, { user: owner.id }));
    expect(snapshot(inline)).toEqual({
      ...FIXED,
      ...own,
      "content-type": "image/png",
      "content-length": "700",
      "content-disposition": `inline; ${name}`,
    });

    // The thumbnail: first made (no validator if its cache write had failed — here it has one),
    // then from the cache. `private, no-store` like everything else.
    const url = await urlFor("thumb", node, { user: owner.id });
    for (const thumb of [await ask(url, { env }), await ask(url, { env })]) {
      expect(snapshot(thumb)).toEqual({
        ...FIXED,
        ...own,
        "content-type": "image/webp",
        "content-length": "12",
        "content-disposition": `attachment; ${name}`,
      });
    }

    const ranged = await ask(await urlFor("download", node, { user: owner.id }), {
      headers: { range: "bytes=10-19", origin: TEST_APP_ORIGIN },
    });
    expect(snapshot(ranged)).toEqual({
      ...FIXED,
      ...own,
      "content-type": "image/png",
      "content-length": "10",
      "content-range": "bytes 10-19/700",
      "content-disposition": `attachment; ${name}`,
    });
  });

  it("CORS is the app origin exactly, whoever asks; the preflight is answered for the app origin only", async () => {
    const owner = await makeAccount();
    const { node } = await storedFile(owner.id);
    const url = await urlFor("download", node, { user: owner.id });
    for (const origin of [TEST_APP_ORIGIN, "https://evil.example", undefined]) {
      const answer = await ask(url, { headers: origin ? { origin } : {} });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("access-control-allow-origin")).toBe(TEST_APP_ORIGIN);
      expect(answer.headers.get("access-control-allow-credentials")).toBeNull();
      expect(answer.headers.get("vary")).toBe("Origin");
    }
    const preflight = await ask(url, { method: "OPTIONS", headers: { origin: TEST_APP_ORIGIN } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("Range, If-None-Match, If-Range");
    expect(preflight.headers.get("access-control-max-age")).toBe("600");
    expectFixed(preflight, "preflight");
    for (const headers of [{ origin: "https://evil.example" }, {}] as Record<string, string>[]) {
      const refused = await ask(url, { method: "OPTIONS", headers });
      expect(refused.status).toBe(404);
      expect(refused.text).toBe("Not found\n");
      expect(refused.headers.get("access-control-allow-methods")).toBeNull();
    }
  });

  it("an active type is an octet-stream attachment on /d/ — HTML, SVG, XML, XHTML — and has no inline view at all", async () => {
    const owner = await makeAccount();
    for (const [mime, name] of [
      ["text/html", "page.html"],
      ["image/svg+xml", "logo.svg"],
      ["application/xml", "feed.xml"],
      ["application/xhtml+xml", "doc.xhtml"],
      ["text/xml", "data.xml"],
      // A detected type that is no bare type/subtype at all.
      ["text/html; charset=utf-8", "sneaky.txt"],
      [null, "unknown"],
    ] as const) {
      const { node } = await storedFile(owner.id, { mime, name });
      const answer = await ask(await urlFor("download", node, { user: owner.id }));
      expect(answer.status, name).toBe(200);
      expect(answer.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(answer.headers.get("content-disposition"), name).toMatch(/^attachment; /);
      const inline = await ask(await urlFor("inline", node, { user: owner.id }));
      expect(inline.status, name).toBe(403);
    }
  });

  it("a file name with quotes, CR/LF, a path separator or bidi controls cannot break the header; a unicode name travels as filename*", async () => {
    const owner = await makeAccount();
    const names: Array<[string, string, string]> = [
      ['we"ird.txt', 'filename="we_ird.txt"', "filename*=UTF-8''we%22ird.txt"],
      [
        "line\r\nSet-Cookie: x=1.txt",
        'filename="lineSet-Cookie: x=1.txt"',
        "filename*=UTF-8''lineSet-Cookie%3A%20x%3D1.txt",
      ],
      ["a\\b.txt", 'filename="a_b.txt"', "filename*=UTF-8''a_b.txt"],
      [
        "résümé 日本.pdf",
        'filename="r_s_m_ __.pdf"',
        "filename*=UTF-8''r%C3%A9s%C3%BCm%C3%A9%20%E6%97%A5%E6%9C%AC.pdf",
      ],
      ["invoice‮exe.pdf", 'filename="invoiceexe.pdf"', "filename*=UTF-8''invoiceexe.pdf"],
      ["50%.txt", 'filename="50_.txt"', "filename*=UTF-8''50%25.txt"],
    ];
    for (const [name, fallback, extended] of names) {
      const { node } = await storedFile(owner.id, { name: `${rand(2)}-${name}`, mime: "text/plain" });
      const answer = await ask(await urlFor("download", node, { user: owner.id }));
      expect(answer.status, name).toBe(200);
      const header = answer.headers.get("content-disposition")!;
      expect(header, name).not.toMatch(/[\r\n]/);
      expect(header.startsWith("attachment; "), name).toBe(true);
      expect(header, name).toContain(fallback.replace('filename="', ""));
      expect(header, name).toContain(extended.replace("filename*=UTF-8''", ""));
      expect(answer.headers.get("set-cookie"), name).toBeNull();
      // Exactly one quoted fallback and one extended name: nothing was injected.
      expect(header.match(/filename="/g), name).toHaveLength(1);
      expect(header.match(/filename\*=/g), name).toHaveLength(1);
    }
  });

  it("no response on this host is ever text/html or carries a cookie — every route, every refusal, and 50 random paths", async () => {
    const owner = await makeAccount();
    const { node } = await storedFile(owner.id, { mime: "text/html", name: "x.html" });
    const link = await linkOn(node.id, owner.id);
    const env = { IMAGES: imagesMock().binding };
    const paths: string[] = [];
    for (const kind of ["download", "inline", "thumb"] as const) {
      paths.push(await urlFor(kind, node, { user: owner.id }));
      paths.push(await urlFor(kind, node, { link }));
      paths.push(`${await urlFor(kind, node, { user: owner.id })}x`);
      const ghost = crypto.randomUUID();
      const token = await signRaw({
        v: 1,
        k: kind,
        n: ghost,
        ver: "v",
        st: "u",
        sub: owner.id,
        exp: 9_999_999_999,
      });
      paths.push(kind === "thumb" ? `/t/${ghost}/320/${token}` : `/${kind[0]}/${ghost}/${token}`);
    }
    const segment = () => rand(1 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 6));
    for (let i = 0; i < 50; i++) {
      const depth = 1 + (i % 4);
      const prefix = ["", "d/", "i/", "t/", "api/", "s/", "assets/"][i % 7];
      paths.push(`/${prefix}${Array.from({ length: depth }, segment).join("/")}`);
    }
    paths.push("/", "/index.html", "/favicon.ico", "/api/health", "/__meta");
    const statuses = new Set<number>();
    for (const path of paths) {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        const answer = await ask(path, { method, env, headers: { cookie: "session=made-up-for-this-test" } });
        statuses.add(answer.status);
        expectFixed(answer, `${method} ${path.slice(0, 12)}`);
        expect(answer.status, `${method} ${path.slice(0, 12)}`).toBeLessThan(500);
        if (answer.status >= 400)
          expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      }
    }
    expect([...statuses].sort()).toEqual([200, 403, 404]);
  });
});
