// Text and code: fetched with an inline URL, shown as source, and never parsed as markup.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PublicPreviewSource } from "../../../../src/client/components/slots";
import { PreviewDialog } from "../../../../src/client/features/preview";
import {
  highlight,
  HIGHLIGHT_LINE_TIME_MS,
  HIGHLIGHT_MAX_LINE_LENGTH,
  HIGHLIGHT_SLICE_MS,
  HIGHLIGHT_TOTAL_MS,
  languageFor,
} from "../../../../src/client/features/preview/renderers/highlight";
import {
  canHighlight,
  decodeText,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINE,
  HIGHLIGHT_MAX_LINES,
  TEXT_MAX_LINES,
  TEXT_MAX_PIECES,
} from "../../../../src/client/features/preview/renderers/text";
import { PREVIEW_TEXT_MAX_BYTES } from "../../../../src/shared/constants";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { filesUrl, ID, NODES, nodeOf } from "./fixtures";
import {
  dialog,
  envelope,
  installFetch,
  ownerApi,
  preloadRenderers,
  renderPreview,
  renderer,
  setupPreview,
  settle,
  state,
  unreadable,
} from "./helpers";

setupPreview();

const noop = () => {};
const HOSTILE = `<script>window.__ran = true</script>\n<img src=x onerror="window.__ran = true">\n</pre></code><h1 id="escaped">out</h1>\n&lt;b&gt; & "quotes"`;
const txt = nodeOf({
  ...NODES.ts,
  id: ID.other,
  name: "notes.txt",
  ext: "txt",
  mimeCategory: "document",
  mimeSniffed: "text/plain",
  size: HOSTILE.length,
});

async function openText(node: NodeDto, body: string | ArrayBuffer, extra?: Parameters<typeof ownerApi>[1]) {
  await preloadRenderers();
  const api = ownerApi([node], extra);
  const network = installFetch({ api: api.handler, files: () => new Response(body, { status: 200 }) });
  renderPreview(<PreviewDialog open nodeId={node.id} onClose={noop} source="owner" />);
  await screen.findByText(node.name);
  return { api, network };
}

const pre = () => dialog()!.querySelector<HTMLElement>('[data-preview-renderer="text"] pre');

describe("TextPreview", () => {
  it("a .txt full of markup renders as the characters it contains — nothing is parsed, nothing runs", async () => {
    await openText(txt, HOSTILE);
    await waitFor(() => expect(pre()).not.toBeNull());
    const shown = Array.from(pre()!.querySelectorAll("[data-line]"), (line) => line.textContent).join("\n");
    expect(shown).toBe(HOSTILE);
    expect(pre()!.querySelector("script, img, h1, b")).toBeNull();
    expect(document.getElementById("escaped")).toBeNull();
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined();
    // One line per line of the file, numbered by the stylesheet (so a copy carries no numbers).
    expect(pre()!.querySelectorAll("[data-line]").length).toBe(4);
    expect(pre()!.textContent).not.toMatch(/^1/);
  });

  it("asks for an `inline` URL, never `download`, and fetches it once without a cookie", async () => {
    const { api, network } = await openText(txt, "hello");
    await waitFor(() => expect(pre()).not.toBeNull());
    await settle(10);
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline"]);
    expect(network.files().map((call) => `${call.method} ${call.url.href}`)).toEqual([
      `GET ${filesUrl("inline", ID.other, "tok-1")}`,
    ]);
  });

  it("Markdown is shown as source", async () => {
    const md = nodeOf({ ...txt, name: "README.md", ext: "md", mimeSniffed: "text/markdown" });
    await openText(md, "# Title\n\n[a link](javascript:alert(1))\n");
    await waitFor(() => expect(pre()).not.toBeNull());
    expect(pre()!.querySelector("[data-line]")!.textContent).toBe("# Title");
    expect(dialog()!.querySelector("h1, a[href]")).toBeNull();
  });

  it("a final line break ends the last line; it does not add an empty one", async () => {
    await openText(txt, "one\ntwo\n");
    await waitFor(() => expect(pre()).not.toBeNull());
    expect(Array.from(pre()!.querySelectorAll("[data-line]"), (line) => line.textContent)).toEqual([
      "one",
      "two",
    ]);
  });

  it("the wrap toggle changes how long lines are laid out, not what they say", async () => {
    await openText(txt, "one\ntwo");
    await waitFor(() => expect(pre()).not.toBeNull());
    expect(pre()!.getAttribute("data-wrap")).toBe("false");
    fireEvent.click(screen.getByRole("checkbox", { name: "Wrap lines" }));
    expect(pre()!.getAttribute("data-wrap")).toBe("true");
    expect(pre()!.querySelectorAll("[data-line]").length).toBe(2);
  });

  it("bytes that are not UTF-8 are read as Latin-1", async () => {
    expect(decodeText(new TextEncoder().encode("naïve — ✓").buffer as ArrayBuffer)).toBe("naïve — ✓");
    expect(decodeText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]).buffer)).toBe("café");
    await openText(txt, Uint8Array.from([0x63, 0x61, 0x66, 0xe9]).buffer);
    await waitFor(() => expect(pre()?.textContent).toBe("café"));
  });

  it("a long file shows its first lines and says so", async () => {
    const lines = Array.from({ length: TEXT_MAX_LINES + 25 }, (_, index) => `line ${index + 1}`).join("\n");
    await openText(txt, lines);
    await waitFor(() => expect(pre()).not.toBeNull());
    expect(pre()!.querySelectorAll("[data-line]").length).toBe(TEXT_MAX_LINES);
    expect(
      screen.getByText(
        `Showing the first ${TEXT_MAX_LINES} of ${TEXT_MAX_LINES + 25} lines. Download the file for the rest.`,
      ),
    ).toBeTruthy();
  });

  it("above the preview limit nothing is minted: it says the file is too large, with Download", async () => {
    const big = nodeOf({ ...txt, size: PREVIEW_TEXT_MAX_BYTES + 1 });
    const { api, network } = await openText(big, "never fetched");
    await screen.findByText("Too large to preview — download");
    await settle(10);
    expect(renderer()).toBe("none");
    expect(api.minted).toEqual([]);
    expect(network.files()).toEqual([]);
    expect(within(dialog()!).getAllByRole("button", { name: "Download" }).length).toBe(1);
  });
});

describe("TextPreview — refusals", () => {
  it("two 403s from the files host → one re-mint, one retry, the error state without a request id", async () => {
    await preloadRenderers();
    const api = ownerApi([txt]);
    const refusals = [unreadable(403), unreadable(403)];
    let count = 0;
    const network = installFetch({ api: api.handler, files: () => refusals[count++]!.response });
    renderPreview(<PreviewDialog open nodeId={txt.id} onClose={noop} source="owner" />);
    await waitFor(() => expect(state()).toBe("error"));
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline", "inline"]);
    expect(network.files().map((call) => call.url.pathname)).toEqual([
      `/i/${ID.other}/tok-1`,
      `/i/${ID.other}/tok-2`,
    ]);
    expect(within(dialog()!).queryByText(/^req /)).toBeNull();
    for (const refusal of refusals) expect(refusal.read).not.toHaveBeenCalled();
    await settle(20);
    expect(network.files().length).toBe(2);
  });

  it("the error state has Try again: it starts a NEW view — a new mint, a new fetch — and nothing does so by itself", async () => {
    await preloadRenderers();
    const api = ownerApi([txt]);
    let refuse = true;
    const network = installFetch({
      api: api.handler,
      files: () => (refuse ? unreadable(403).response : new Response("now it works")),
    });
    renderPreview(<PreviewDialog open nodeId={txt.id} onClose={noop} source="owner" />);
    await waitFor(() => expect(state()).toBe("error"));
    expect(api.minted.length).toBe(2);
    // Left alone, it stays where it is.
    await settle(50);
    expect(api.minted.length).toBe(2);
    expect(network.files().length).toBe(2);
    refuse = false;
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pre()?.textContent).toBe("now it works"));
    expect(api.minted.length).toBe(3);
    expect(network.files().length).toBe(3);
  });

  it("a 403 and then the text → the text", async () => {
    await preloadRenderers();
    const api = ownerApi([txt]);
    let count = 0;
    installFetch({
      api: api.handler,
      files: () => (count++ === 0 ? unreadable(403).response : new Response("second try")),
    });
    renderPreview(<PreviewDialog open nodeId={txt.id} onClose={noop} source="owner" />);
    await waitFor(() => expect(pre()?.textContent).toBe("second try"));
    expect(api.minted.length).toBe(2);
  });

  it("a refused mint → the error state WITH the API's request id, and no fetch to the files host", async () => {
    await preloadRenderers();
    const api = ownerApi([txt], (call) =>
      call.url.pathname.endsWith("/download-url") ? envelope("scan_blocked", 403) : undefined,
    );
    const network = installFetch({ api: api.handler });
    renderPreview(<PreviewDialog open nodeId={txt.id} onClose={noop} source="owner" />);
    await waitFor(() => expect(state()).toBe("error"));
    expect(within(dialog()!).getByText("req req-1234")).toBeTruthy();
    expect(network.files()).toEqual([]);
  });

  it("a public source: the text comes through getUrl('inline') and the API is never asked", async () => {
    await preloadRenderers();
    const network = installFetch({ files: () => new Response("public text") });
    const source: PublicPreviewSource = {
      getItem: vi.fn(async () => ({ ...txt, scanStatus: undefined, thumb: undefined })),
      getUrl: vi.fn(async (nodeId: string, kind: "inline" | "thumb") => ({
        url: filesUrl(kind, nodeId, "pub-1"),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      })),
    };
    renderPreview(<PreviewDialog open nodeId={txt.id} onClose={noop} source={source} />);
    await waitFor(() => expect(pre()?.textContent).toBe("public text"));
    expect(source.getUrl).toHaveBeenCalledTimes(1);
    expect(source.getUrl).toHaveBeenCalledWith(txt.id, "inline", undefined);
    expect(network.api()).toEqual([]);
  });
});

describe("highlighting", () => {
  // The grammar and the engine are loaded once, before the tests that wait for colours — so none
  // of them waits on a cold import.
  beforeAll(async () => {
    await highlight("const warm = 1;", "typescript");
  });

  it("a line longer than the limit is left plain, by the grammar's own limit and before it is even asked", async () => {
    const long = `const s = "${"x".repeat(HIGHLIGHT_MAX_LINE_LENGTH)}";`;
    const lines = (await highlight(`const a = 1;\n${long}\n`, "typescript"))!;
    expect(lines[0]!.some((piece) => piece.token === "keyword")).toBe(true);
    // The long line comes back as it is, with no token on any piece.
    expect(lines[1]!.map((piece) => piece.text).join("")).toBe(long);
    expect(lines[1]!.every((piece) => piece.token === undefined)).toBe(true);

    // In the viewer such a file is not handed to the highlighter at all.
    await openText(NODES.ts, `const a = 1;\n${long}\n`);
    await waitFor(() => expect(pre()).not.toBeNull());
    await settle(50);
    expect(dialog()!.querySelector('[data-preview-renderer="text"]')!.getAttribute("data-highlighted")).toBe(
      "false",
    );
    expect(pre()!.querySelectorAll("[data-line]").length).toBe(2);
    expect(HIGHLIGHT_MAX_LINE).toBe(HIGHLIGHT_MAX_LINE_LENGTH);
  });

  it("a language comes from the extension; an unknown one is plain text", () => {
    expect(languageFor("ts")).toBe("typescript");
    expect(languageFor(".TSX")).toBe("tsx");
    expect(languageFor("md")).toBe("markdown");
    expect(languageFor("txt")).toBeNull();
    expect(languageFor("")).toBeNull();
  });

  it("the highlighter's result is pieces of text with a token name — the file's text, unchanged", async () => {
    const code = 'const tag: string = "<script>alert(1)</script>"; // done\n\nexport default tag;\n';
    const lines = (await highlight(code, "typescript"))!;
    expect(lines.map((line) => line.map((piece) => piece.text).join("")).join("\n")).toBe(code);
    const tokens = new Set(lines.flat().map((piece) => piece.token));
    expect(tokens.has("keyword")).toBe(true);
    expect(tokens.has("comment")).toBe(true);
    for (const piece of lines.flat()) {
      expect(typeof piece.text).toBe("string");
      if (piece.token !== undefined) expect(piece.token).toMatch(/^[a-z-]+$/);
    }
  });

  it("a .ts file is highlighted in the page: token spans, and its markup-looking string stays text", async () => {
    const source = 'export const markup = "<script>window.__ran = true</script>";\n';
    await openText(NODES.ts, source);
    await waitFor(() => expect(pre()).not.toBeNull());
    await waitFor(() =>
      expect(
        dialog()!.querySelector('[data-preview-renderer="text"]')!.getAttribute("data-highlighted"),
      ).toBe("true"),
    );
    expect(pre()!.querySelectorAll('[data-token="keyword"]').length).toBeGreaterThan(0);
    expect(pre()!.querySelector("[data-line]")!.textContent).toBe(source.trimEnd());
    expect(pre()!.querySelector("script")).toBeNull();
    expect(pre()!.querySelector("[style]")).toBeNull();
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined();
  });
});

describe("highlighting — its bounds are decided before it starts", () => {
  beforeAll(async () => {
    await highlight("const warm = 1;", "typescript");
    await highlight("warm", "markdown");
    await highlight("warm", "shellscript");
  });

  it("the constants", () => {
    expect([
      HIGHLIGHT_MAX_CHARS,
      HIGHLIGHT_MAX_LINES,
      HIGHLIGHT_MAX_LINE,
      TEXT_MAX_LINES,
      TEXT_MAX_PIECES,
    ]).toEqual([200_000, 5_000, 2_000, 5_000, 50_000]);
    expect([HIGHLIGHT_SLICE_MS, HIGHLIGHT_LINE_TIME_MS, HIGHLIGHT_TOTAL_MS]).toEqual([8, 8, 2_000]);
  });

  it("characters AND line count AND longest line — each alone refuses", () => {
    const lines = (count: number, length: number) => Array.from({ length: count }, () => "x".repeat(length));
    const chars = (all: string[]) => all.reduce((sum, line) => sum + line.length + 1, 0);
    const ok = lines(1000, 100);
    expect(canHighlight(ok, chars(ok))).toBe(true);
    // Characters: 200,000 is in, one more is out.
    expect(canHighlight(["a"], HIGHLIGHT_MAX_CHARS)).toBe(true);
    expect(canHighlight(["a"], HIGHLIGHT_MAX_CHARS + 1)).toBe(false);
    // Lines: short ones, few characters, too many of them.
    expect(canHighlight(lines(HIGHLIGHT_MAX_LINES, 1), 10_000)).toBe(true);
    expect(canHighlight(lines(HIGHLIGHT_MAX_LINES + 1, 1), 10_001)).toBe(false);
    // Longest line: one line over the limit in an otherwise tiny file.
    expect(canHighlight(["ok", "x".repeat(HIGHLIGHT_MAX_LINE)], 2_003)).toBe(true);
    expect(canHighlight(["ok", "x".repeat(HIGHLIGHT_MAX_LINE + 1)], 2_004)).toBe(false);
  });

  it.each([
    ["too many characters", `${"const a = 1; ".repeat(100)}\n`.repeat(160)],
    ["too many lines", "const a = 1;\n".repeat(HIGHLIGHT_MAX_LINES + 1)],
    ["one line too long", `const a = "${"x".repeat(HIGHLIGHT_MAX_LINE)}";\nconst b = 2;\n`],
  ])(
    "%s: the highlighter is never called and the text is shown plain, as text nodes",
    async (_name, source) => {
      const module = await import("../../../../src/client/features/preview/renderers/highlight");
      const spy = vi.spyOn(module, "highlight");
      await openText(nodeOf({ ...NODES.ts, size: 1000 }), source);
      await waitFor(() => expect(pre()).not.toBeNull());
      await settle(50);
      expect(spy).not.toHaveBeenCalled();
      expect(
        dialog()!.querySelector('[data-preview-renderer="text"]')!.getAttribute("data-highlighted"),
      ).toBe("false");
      expect(pre()!.querySelector("[data-token]")).toBeNull();
      expect(pre()!.querySelector("[data-line]")!.textContent).toBe(source.split("\n")[0]);
    },
  );

  it("a megabyte of one-character lines draws 5,000 lines — about ten thousand elements, not millions", async () => {
    const source = "x\n".repeat(500_000);
    await openText(nodeOf({ ...NODES.ts, size: source.length }), source);
    await waitFor(() => expect(pre()).not.toBeNull());
    expect(pre()!.querySelectorAll("[data-line]").length).toBe(TEXT_MAX_LINES);
    expect(pre()!.querySelectorAll("*").length).toBeLessThanOrEqual(2 * TEXT_MAX_LINES + 1);
    expect(
      screen.getByText("Showing the first 5000 of 500000 lines. Download the file for the rest."),
    ).toBeTruthy();
  });

  it("the grammar's state is carried from line to line: the middle of a block comment is a comment", async () => {
    const source = ["const a = 1; /* opens here", "still inside", "*/ const after = 1;"];
    const lines = (await highlight(source.join("\n"), "typescript"))!;
    expect(lines.map((line) => line.map((piece) => piece.text).join(""))).toEqual(source);
    expect(lines[1]!.every((piece) => piece.token === "comment")).toBe(true);
    expect(lines[2]!.some((piece) => piece.token === "keyword")).toBe(true);
  });
});

describe("highlighting — bounded in time, and stopped promptly", () => {
  // The round-2 review's crafted files: 200 lines of 999 characters, inside every size bound.
  const crafted = (unit: string) =>
    Array.from({ length: 200 }, () => unit.repeat(Math.floor(999 / unit.length))).join("\n");

  beforeAll(async () => {
    await highlight("const warm = 1;", "typescript");
    await highlight("warm", "markdown");
    await highlight("warm", "shellscript");
  });

  /** A clock on which every look at the time finds `step` ms gone. */
  const ticking = (step: number) => {
    let at = 0;
    return () => (at += step);
  };

  it("the run yields after 8 ms of work, however many lines that is — a slice is time, not lines", async () => {
    const source = "const a = 1;\n".repeat(100);
    const slices: number[] = [];
    // The clock moves 1 ms at every look, three looks a line: a slice is over after a few lines.
    const lines = await highlight(source, "typescript", {
      now: ticking(1),
      onSlice: (ms) => slices.push(ms),
    });
    expect(lines!.length).toBe(101);
    expect(slices.length).toBeGreaterThanOrEqual(25);
    expect(Math.max(...slices)).toBeLessThanOrEqual(HIGHLIGHT_SLICE_MS + 3);
    // On a clock that never moves there is nothing to yield for.
    const none: number[] = [];
    await highlight(source, "typescript", { now: () => 0, onSlice: (ms) => none.push(ms) });
    expect(none).toEqual([]);
  });

  it("a run that has used its two seconds of work gives up: the text stays plain", async () => {
    const slices: number[] = [];
    const lines = await highlight("const a = 1;\n".repeat(300), "typescript", {
      now: ticking(60),
      onSlice: (ms) => slices.push(ms),
    });
    expect(lines).toBeNull();
    expect(slices.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(HIGHLIGHT_TOTAL_MS);
    expect(slices.length).toBeLessThan(40);
  });

  it("an aborted run ends at its next yield — not at the end of the file", async () => {
    const gone = new AbortController();
    gone.abort();
    expect(await highlight("const a = 1;", "typescript", { signal: gone.signal })).toBeNull();

    const midway = new AbortController();
    const slices: number[] = [];
    const lines = await highlight("const a = 1;\n".repeat(300), "typescript", {
      signal: midway.signal,
      now: ticking(10),
      onSlice: (ms) => {
        slices.push(ms);
        midway.abort();
      },
    });
    expect(lines).toBeNull();
    // One line was done, the run yielded, found the signal aborted and stopped.
    expect(slices.length).toBe(1);
  });

  it.each([
    ["typescript", "a<"],
    ["markdown", "*_"],
    ["shellscript", "$(( `"],
  ])(
    "the crafted %s file (%j × 200 lines): no stretch of work on the main thread is long",
    async (lang, unit) => {
      const slices: number[] = [];
      const started = performance.now();
      const lines = await highlight(crafted(unit), lang, { onSlice: (ms) => slices.push(ms) });
      const took = performance.now() - started;
      // It was 5.6–12.9 s in ONE uninterruptible slice. Now: the longest stretch between two
      // yields is a slice (8 ms) plus at most one line's limit (8 ms) — measured, with room for a
      // loaded machine — and the whole run is over, one way or the other, within its total budget.
      expect(Math.max(0, ...slices)).toBeLessThan(100);
      expect(took).toBeLessThan(HIGHLIGHT_TOTAL_MS + 1_000);
      if (lines !== null) expect(lines.length).toBe(200);
    },
  );

  it("a file that cuts into more pieces than are drawn stops early and stays plain — in the function and in the viewer", async () => {
    // `a<` × 499 per line: about a thousand pieces a line, so the cap is passed near line 50.
    const source = crafted("a<");
    const slices: number[] = [];
    expect(await highlight(source, "typescript", { onSlice: (ms) => slices.push(ms) })).toBeNull();
    await openText(nodeOf({ ...NODES.ts, size: source.length }), source);
    await waitFor(() => expect(pre()).not.toBeNull());
    await settle(300);
    expect(dialog()!.querySelector('[data-preview-renderer="text"]')!.getAttribute("data-highlighted")).toBe(
      "false",
    );
    expect(pre()!.querySelector("[data-token]")).toBeNull();
    expect(pre()!.querySelectorAll("*").length).toBeLessThanOrEqual(2 * 200 + 1);
  });

  it("closing the preview aborts the run it started", async () => {
    const module = await import("../../../../src/client/features/preview/renderers/highlight");
    const spy = vi.spyOn(module, "highlight");
    await preloadRenderers();
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => new Response("const a = 1;\n".repeat(600)) });
    const view = renderPreview(<PreviewDialog open nodeId={NODES.ts.id} onClose={noop} source="owner" />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const signal = spy.mock.calls[0]![2]!.signal!;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
