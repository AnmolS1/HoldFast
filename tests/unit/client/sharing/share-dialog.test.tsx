// The share dialog (T08's ShareDialog slot): who has access, people, links, the settings sentence,
// Copy link, pause / resume where the API allows, revoke — and every change dropped when the
// account changes while it is in flight.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { ShareDialog } from "../../../../src/client/features/share";
import { adoptIdentity, purgeUserState } from "../../../../src/client/lib/query";
import type { NodeSharingDto, ShareDto } from "../../../../src/shared/schemas/share";
import { renderShell } from "../shell/helpers";
import { deferred } from "../views/helpers";
import {
  AT,
  envelope,
  FOLDER_ID,
  json,
  link,
  mockFetchCalls,
  sessionOf,
  setupShell,
  type MockCall,
} from "./helpers";

setupShell();

const SHARE: ShareDto = {
  id: "0199d3c2-7a10-7000-8000-0000000005a1",
  nodeId: FOLDER_ID,
  email: "friend@example.test",
  role: "editor",
  canUpload: true,
  createdAt: AT,
};

function sharing(overrides: Partial<NodeSharingDto> = {}): NodeSharingDto {
  return {
    shares: [SHARE],
    links: [link({ nodeId: FOLDER_ID, node: { name: "Holiday", kind: "folder" } })],
    inheritedFrom: null,
    ...overrides,
  };
}

const NODE_DETAIL = {
  node: {
    id: FOLDER_ID,
    parentId: null,
    kind: "folder",
    name: "Holiday",
    ext: "",
    size: 0,
    mimeCategory: "other",
    mimeSniffed: null,
    etag: "",
    sha256: null,
    scanStatus: "clean",
    scanReason: null,
    pua: [],
    thumb: false,
    starred: false,
    createdAt: AT,
    updatedAt: AT,
    lastAccessedAt: null,
    deletedAt: null,
    purgeAfter: null,
    owner: { id: "u".repeat(32), displayName: "Ada" },
    createdBy: null,
    role: "owner",
    sharing: { people: 1, link: "active", summary: "both" },
  },
  breadcrumbs: [],
};

type Handler = (call: MockCall) => Response | Promise<Response> | undefined;

async function open(extra: Handler = () => undefined, data: NodeSharingDto = sharing()) {
  const onClose = vi.fn();
  const calls = mockFetchCalls((call) => {
    const answer = extra(call);
    if (answer) return answer;
    if (call.method === "GET" && call.path === `/api/nodes/${FOLDER_ID}/sharing`) return json(data);
    if (call.method === "GET" && call.path === `/api/nodes/${FOLDER_ID}`) return json(NODE_DETAIL);
    if (call.method === "GET" && call.path.startsWith("/api/links/"))
      return json({ days: [], countries: [], outcomes: {} });
    return undefined;
  });
  // The consumer closes the dialog when it asks to be closed, as the explorer does.
  function Host() {
    const [shown, setShown] = useState(true);
    return (
      <ShareDialog
        open={shown}
        nodeId={FOLDER_ID}
        onClose={() => {
          onClose();
          setShown(false);
        }}
      />
    );
  }
  renderShell(<Host />);
  await screen.findByRole("heading", { name: "Share Holiday" });
  await screen.findByText("friend@example.test");
  return { calls, onClose, dialog: screen.getByRole("dialog") };
}

const sharingReads = (calls: MockCall[]) =>
  calls.filter((call) => call.method === "GET" && call.path === `/api/nodes/${FOLDER_ID}/sharing`).length;

beforeEach(async () => {
  await adoptIdentity(sessionOf());
});

describe("ShareDialog", () => {
  it("says who has access, lists the people and the link, and reads the settings as a sentence", async () => {
    const { dialog } = await open(
      undefined,
      sharing({ inheritedFrom: { nodeId: "0199d3c2-7a10-7000-8000-0000000000d9", name: "Family" } }),
    );
    expect(within(dialog).getByText("1 person and anyone with a link")).toBeTruthy();
    expect(within(dialog).getByText("People with access to Family can also see this.")).toBeTruthy();
    const sentence = dialog.querySelector("[data-link-sentence]")!;
    expect(sentence.textContent).toBe(
      "Anyone with the link can view · no password · never expires · unlimited downloads",
    );
    expect(within(dialog).getByLabelText("Can add files")).toBeTruthy();
  });

  it("Copy link copies the URL the API re-derived (any time later)", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link().url));
    expect(getToasts().map((toast) => toast.message)).toContain("Link copied");
  });

  it.each([
    ["self_share", envelope("validation", 400, { reason: "self_share" }), "You can't share with yourself."],
    [
      "duplicate",
      envelope("conflict", 409, { reason: "duplicate" }),
      "This is already shared with that address.",
    ],
    [
      "grantee_limit",
      envelope("conflict", 409, { reason: "grantee_limit" }),
      "This is shared with as many people as it can be.",
    ],
    [
      "ceiling",
      envelope("ceiling_exceeded", 429, { kind: "share_user", dimension: "count" }, { "Retry-After": "60" }),
      "You've reached today's sharing limit. Try again tomorrow.",
    ],
  ])("a refused share (%s) is said in the dialog's own words", async (_name, answer, words) => {
    const { dialog, calls } = await open((call) => (call.method === "POST" ? answer.clone() : undefined));
    fireEvent.change(within(dialog).getByLabelText(/Email address/), { target: { value: "x@example.test" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));
    expect(await within(dialog).findByText(words)).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      email: "x@example.test",
      role: "viewer",
    });
  });

  it("Pause for a live link; Resume only where the API allows; neither for a link paused for review", async () => {
    const { dialog } = await open(
      undefined,
      sharing({
        links: [
          link({ id: "0199d3c2-7a10-7000-8000-0000000001b1" }),
          link({
            id: "0199d3c2-7a10-7000-8000-0000000001b2",
            state: "paused",
            pausedReasons: ["owner"],
            canUnpause: true,
          }),
          link({
            id: "0199d3c2-7a10-7000-8000-0000000001b3",
            state: "paused",
            pausedReasons: ["review"],
            canUnpause: false,
          }),
        ],
      }),
    );
    const row = (id: string) => dialog.querySelector<HTMLElement>(`[data-share-link="${id}"]`)!;
    expect(
      within(row("0199d3c2-7a10-7000-8000-0000000001b1")).getByRole("button", { name: "Pause" }),
    ).toBeTruthy();
    expect(
      within(row("0199d3c2-7a10-7000-8000-0000000001b2")).getByRole("button", { name: "Resume" }),
    ).toBeTruthy();
    const review = row("0199d3c2-7a10-7000-8000-0000000001b3");
    expect(within(review).queryByRole("button", { name: /Pause|Resume/ })).toBeNull();
    expect(within(review).getByText("Paused while it is reviewed.")).toBeTruthy();
  });

  it("Revoke is confirmed, states the blast radius, then sends one DELETE", async () => {
    const { dialog, calls } = await open((call) =>
      call.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this link?" });
    expect(within(confirm).getByText(/loses access, now and for good/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
        `/api/links/${link().id}`,
      ]),
    );
  });
});

describe("ShareDialog — an account change while a change is in flight", () => {
  type Start = (dialog: HTMLElement) => void | Promise<void>;
  const cases: Array<[string, string, Start]> = [
    [
      "share with a person",
      "POST",
      (dialog) => {
        fireEvent.change(within(dialog).getByLabelText(/Email address/), {
          target: { value: "y@example.test" },
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));
      },
    ],
    [
      "remove a person",
      "DELETE",
      (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "Remove friend@example.test" })),
    ],
    [
      "pause a link",
      "PATCH",
      (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "Pause" })),
    ],
    [
      "create a link",
      "POST",
      (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "Create link" })),
    ],
    [
      "revoke a link",
      "DELETE",
      async (dialog) => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
        const confirm = await screen.findByRole("dialog", { name: "Revoke this link?" });
        fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
      },
    ],
  ];

  it.each(cases)(
    "%s: the dialog closes with the account, and the late answer writes nothing",
    async (_name, method, start) => {
      const answer = deferred<Response>();
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const { dialog, calls, onClose } = await open((call) =>
        call.method === method ? answer.promise : undefined,
      );
      const readsBefore = sharingReads(calls);
      await act(async () => {
        await start(dialog);
      });
      await waitFor(() => expect(calls.some((call) => call.method === method)).toBe(true));
      await act(() => purgeUserState({ keepSession: true }));
      expect(onClose).toHaveBeenCalled();
      const toastsBefore = getToasts().length;
      await act(async () => {
        answer.resolve(
          method === "DELETE"
            ? new Response(null, { status: 204 })
            : json(
                method === "PATCH"
                  ? link({ state: "paused", pausedReasons: ["owner"], canUnpause: true })
                  : method === "POST" && _name === "create a link"
                    ? link()
                    : SHARE,
                method === "POST" ? 201 : 200,
              ),
        );
      });
      // Nothing for the previous account: no toast, no list read again on its behalf.
      expect(getToasts().length).toBe(toastsBefore);
      expect(sharingReads(calls)).toBe(readsBefore);
      // A new link of the previous account is not copied for the next one.
      expect(writeText).not.toHaveBeenCalled();
    },
  );
});
