// The trash: restore, delete forever, empty trash — what each asks of the API, what it tells the
// other features, and what it shows when the API refuses.
import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import {
  CONFIRM_WORD,
  emptyTrash,
  EmptyTrashStalled,
  needsTypedConfirm,
  STALLED_ROUNDS,
  TYPED_CONFIRM_ABOVE,
} from "../../../../src/client/features/trash/queries";
import { getEmptyRun, resetEmptyRun, startEmptyTrash } from "../../../../src/client/features/trash/empty-run";
import { viewKeys } from "../../../../src/client/features/starred/view-queries";
import { ApiError } from "../../../../src/client/lib/api";
import { purgeUserState, queryClient, sessionQuery } from "../../../../src/client/lib/query";
import { mockFetch, sessionOf, setupShell } from "../shell/helpers";
import {
  FOLDER_ID,
  nodeId,
  remaining,
  restored,
  TRASH,
  trashItems,
  trashPage,
  USAGE,
  USAGE_AFTER_EMPTY,
} from "./fixtures";
import {
  answering,
  deferred,
  envelope,
  json,
  openView,
  pathOf,
  queryOf,
  recordNodesChanged,
  requests,
  rowNames,
  type Answers,
} from "./helpers";

setupShell();
afterEach(() => {
  vi.useRealTimers();
  resetEmptyRun();
});
const events = recordNodesChanged();

const [REPORT, NOTES, FOLDER] = TRASH.items as [
  (typeof TRASH.items)[number],
  (typeof TRASH.items)[number],
  (typeof TRASH.items)[number],
];
const NO_CONTENT = () => new Response(null, { status: 204 });
const usageCalls = (calls: Parameters<typeof requests>[0]) =>
  requests(calls, "GET", "/api/account/usage").length;

/**
 * The mocked API behaves like the real one in one respect the page depends on: a row a restore
 * or a delete answered `2xx` for is no longer listed by the next `GET /api/trash`.
 */
async function openTrash(answers: Answers = {}, width = 1280) {
  const gone = new Set<string>();
  const stateful: Answers = {};
  for (const [key, answer] of Object.entries(answers)) {
    const id = /^(?:POST|DELETE) \/api\/nodes\/([^/]+)/.exec(key)?.[1];
    stateful[key] = id
      ? async (call) => {
          const response = await answering({ [key]: answer })(call);
          if (response?.ok) gone.add(id);
          return response;
        }
      : answer;
  }
  const view = await openView(
    "/trash",
    {
      "GET /api/trash": () => json(trashPage(TRASH.items.filter((item) => !gone.has(item.id)))),
      ...stateful,
    },
    { width },
  );
  await waitFor(() => expect(rowNames().length).toBeGreaterThan(0));
  return view;
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${name}` }));
}

describe("the list", () => {
  it("shows trashed roots with when they were deleted and when they are deleted for good — as dates", async () => {
    const { calls } = await openTrash();
    expect(rowNames()).toEqual([REPORT.id, NOTES.id, FOLDER.id]);
    const row = document.querySelector(`[data-item-id="${REPORT.id}"]`)!;
    expect(row.textContent).toContain("Deleted Oct 02 · Deleted forever on Nov 01");
    expect(document.querySelector("[data-trash-count]")!.textContent).toBe("3 items");
    // One page of the contract's maximum, so 100 and 101 can be told apart.
    expect(queryOf(requests(calls, "GET", "/api/trash")[0]!).get("limit")).toBe("200");
  });

  it("asks for the next page with the cursor the last one gave", async () => {
    const { calls } = await openTrash({
      "GET /api/trash": (call) =>
        json(
          queryOf(call).get("cursor") === "c2"
            ? trashPage(trashItems(2).map((item) => ({ ...item, id: nodeId(500 + Number(item.size)) })))
            : trashPage(TRASH.items, "c2"),
        ),
    });
    expect(document.querySelector("[data-trash-count]")!.textContent).toBe("More than 3 items");
    const { intersect } = await import("../shell/helpers");
    act(() => intersect());
    await waitFor(() => expect(rowNames()).toHaveLength(5));
    expect(requests(calls, "GET", "/api/trash").map((call) => queryOf(call).get("cursor"))).toEqual([
      null,
      "c2",
    ]);
  });

  it("nothing opens from the trash: Enter on a row navigates nowhere", async () => {
    const { router } = await openTrash();
    fireEvent.keyDown(document.querySelector(`[data-item-id="${REPORT.id}"]`)!, { key: "Enter" });
    expect(router.state.location.pathname).toBe("/trash");
    expect(getToasts().map((toast) => toast.message)).toEqual(["Restore this item to open it."]);
  });

  it("an empty trash says so, and 'Empty trash' has nothing to do", async () => {
    await openView("/trash", { "GET /api/trash": trashPage([]) });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trash is empty" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("restore", () => {
  it("calls the API, drops the row, and emits exactly [restored.parentId]", async () => {
    const { calls } = await openTrash({
      [`POST /api/nodes/${REPORT.id}/restore`]: restored(REPORT),
    });
    const usageBefore = usageCalls(calls);
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(rowNames()).not.toContain(REPORT.id));
    expect(events).toEqual([[FOLDER_ID]]);
    expect(getToasts().map((toast) => toast.message)).toContain("report.pdf restored");
    // The storage numbers are read again (the bar in the sidebar is on the page).
    await waitFor(() => expect(usageCalls(calls)).toBe(usageBefore + 1));
  });

  it("emits [null] when it came back to the top level, and names it as the API renamed it", async () => {
    await openTrash({
      [`POST /api/nodes/${REPORT.id}/restore`]: restored(REPORT, {
        parentId: null,
        name: "report (restored).pdf",
      }),
    });
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(events).toEqual([[null]]));
    expect(getToasts().map((toast) => toast.message)).toContain("report (restored).pdf restored");
  });

  it.each([
    ["no details", undefined],
    ["details the view must not show", { reason: "held", folder: "Secret folder" }],
  ])("a 409 (%s) shows the one sentence and keeps the row", async (_name, details) => {
    const { calls } = await openTrash({
      [`POST /api/nodes/${REPORT.id}/restore`]: () => envelope("conflict", 409, details),
    });
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    const notice = await waitFor(() => {
      const found = document.querySelector("[data-trash-conflict]");
      if (!found) throw new Error("no conflict notice yet");
      return found;
    });
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toBe("Restore the folder this was in first");
    expect(rowNames()).toContain(REPORT.id);
    expect(events).toEqual([]);
    // Neither the server's message nor its details reach the page or a toast.
    expect(getToasts()).toEqual([]);
    expect(document.body.textContent).not.toContain("conflict message");
    expect(document.body.textContent).not.toContain("Secret folder");
    expect(requests(calls, "POST", `/api/nodes/${REPORT.id}/restore`)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector("[data-trash-conflict]")).toBeNull();
  });

  it("several selected: each is restored, each emits its own parent, a refused one stays", async () => {
    await openTrash({
      [`POST /api/nodes/${REPORT.id}/restore`]: restored(REPORT),
      [`POST /api/nodes/${NOTES.id}/restore`]: () => envelope("conflict", 409),
      [`POST /api/nodes/${FOLDER.id}/restore`]: restored(FOLDER),
    });
    for (const name of ["report.pdf", "notes.txt", "Old projects"])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    const bar = document.querySelector<HTMLElement>("[data-selection-bar]")!;
    fireEvent.click(within(bar).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(rowNames()).toEqual([NOTES.id]));
    expect(events).toEqual([[FOLDER_ID], [null]]);
    expect(document.querySelector("[data-trash-conflict]")!.textContent).toBe(
      "Restore the folder this was in first",
    );
  });
});

describe("delete forever", () => {
  it("the confirmation states finality and what is lost; cancelling deletes nothing", async () => {
    const { calls } = await openTrash();
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete forever/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete report.pdf forever?" });
    expect(within(dialog).getByText("This can't be undone. 1 item.")).toBeTruthy();
    // Focus starts on Cancel, so Enter never destroys anything by reflex.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a folder: the confirmation says its contents go too", async () => {
    await openTrash();
    for (const name of ["report.pdf", "Old projects"])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    const bar = document.querySelector<HTMLElement>("[data-selection-bar]")!;
    fireEvent.click(within(bar).getByRole("button", { name: /Delete forever/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 items forever?" });
    expect(
      within(dialog).getByText("This can't be undone. 2 items. Folders are deleted with everything in them."),
    ).toBeTruthy();
  });

  it("confirmed: DELETE /api/nodes/:id, the row goes, the event is exactly [], usage is read again", async () => {
    const { calls } = await openTrash({ [`DELETE /api/nodes/${REPORT.id}`]: NO_CONTENT });
    const usageBefore = usageCalls(calls);
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete forever/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(rowNames()).not.toContain(REPORT.id));
    expect(requests(calls, "DELETE", `/api/nodes/${REPORT.id}`)).toHaveLength(1);
    expect(events).toEqual([[]]);
    await waitFor(() => expect(usageCalls(calls)).toBe(usageBefore + 1));
    expect(getToasts().map((toast) => toast.message)).toContain("report.pdf deleted forever");
  });

  it("the Delete key asks for the same confirmation for the selection", async () => {
    await openTrash();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select notes.txt" }));
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(await screen.findByRole("dialog", { name: "Delete notes.txt forever?" })).toBeTruthy();
  });

  it("refused by the API: the row stays and the failure is said", async () => {
    await openTrash({ [`DELETE /api/nodes/${REPORT.id}`]: () => envelope("conflict", 409) });
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete forever/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete forever" }),
    );
    await waitFor(() => expect(getToasts().map((toast) => toast.requestId)).toContain("req-1234"));
    expect(rowNames()).toContain(REPORT.id);
  });
});

describe("typed confirmation for emptying the trash", () => {
  it("the threshold is 100: at 100 no typing, at 101 typing", () => {
    expect(TYPED_CONFIRM_ABOVE).toBe(100);
    expect(needsTypedConfirm({ count: 100, more: false })).toBe(false);
    expect(needsTypedConfirm({ count: 101, more: false })).toBe(true);
    expect(needsTypedConfirm({ count: 1, more: false })).toBe(false);
  });

  it("an unknown size is treated as large: further pages, or a list that could not be read", () => {
    expect(needsTypedConfirm({ count: 3, more: true })).toBe(true);
    expect(needsTypedConfirm({ count: null, more: false })).toBe(true);
  });

  it("100 items: the confirm button works at once", async () => {
    await openTrash({ "GET /api/trash": trashPage(trashItems(100)) });
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/^This can't be undone\. 100 items\./)).toBeTruthy();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("101 items: the word must be typed first", async () => {
    const { calls } = await openTrash({ "GET /api/trash": trashPage(trashItems(101)) });
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/^This can't be undone\. 101 items\./)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Empty trash" }) as HTMLButtonElement;
    const input = within(dialog).getByLabelText(`Type ${CONFIRM_WORD} to confirm`);
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "delete" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    fireEvent.change(input, { target: { value: CONFIRM_WORD } });
    expect(confirm.disabled).toBe(false);
  });

  it("more pages than were loaded: 'More than', and typing", async () => {
    await openTrash({ "GET /api/trash": trashPage(TRASH.items, "next") });
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/^This can't be undone\. More than 3 items\./)).toBeTruthy();
    expect(within(dialog).getByLabelText(`Type ${CONFIRM_WORD} to confirm`)).toBeTruthy();
  });
});

describe("the empty-trash loop", () => {
  const scripted = (answers: Array<() => Response>) => {
    let index = 0;
    return mockFetch((call) =>
      call.method === "DELETE" && pathOf(call) === "/api/trash" ? answers[index++]?.() : undefined,
    );
  };
  const accepted = (count: number) => () => json(remaining(count), 202);

  it("repeats on 202 until 204, reporting what is left", async () => {
    const calls = scripted([accepted(240), accepted(120), NO_CONTENT]);
    const progress: number[] = [];
    await emptyTrash((left) => progress.push(left));
    expect(progress).toEqual([240, 120]);
    expect(calls).toHaveLength(3);
  });

  it("a 204 at once is done with no progress", async () => {
    const calls = scripted([NO_CONTENT]);
    const progress: number[] = [];
    await emptyTrash((left) => progress.push(left));
    expect(progress).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("stops on an error: no further call", async () => {
    const calls = scripted([accepted(240), () => envelope("rate_limited", 429), accepted(100), NO_CONTENT]);
    const progress: number[] = [];
    const outcome = await emptyTrash((left) => progress.push(left)).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as ApiError).status).toBe(429);
    expect(progress).toEqual([240]);
    expect(calls).toHaveLength(2);
  });

  it("gives up when the number stops going down, instead of calling for ever", async () => {
    const calls = scripted(Array.from({ length: 50 }, () => accepted(7)));
    const outcome = await emptyTrash(() => {}).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(EmptyTrashStalled);
    expect(calls).toHaveLength(1 + STALLED_ROUNDS);
  });

  it("slow progress is still progress", async () => {
    const calls = scripted([
      accepted(3),
      accepted(3),
      accepted(3),
      accepted(2),
      accepted(2),
      accepted(1),
      NO_CONTENT,
    ]);
    await emptyTrash(() => {});
    expect(calls).toHaveLength(7);
  });

  it("sign-out or an account switch stops a run in flight: the next call is never made", async () => {
    const first = deferred<Response>();
    let made = 0;
    mockFetch((call) => {
      if (call.method !== "DELETE" || pathOf(call) !== "/api/trash") return undefined;
      made += 1;
      return made === 1 ? first.promise : json(remaining(1), 202);
    });
    const run = emptyTrash(() => {}).catch((error: unknown) => error);
    await waitFor(() => expect(made).toBe(1));
    await purgeUserState();
    first.resolve(json(remaining(10), 202));
    const outcome = (await run) as Error;
    expect(outcome.name).toBe("AbortError");
    expect(made).toBe(1);
  });
});

describe("empty trash, from the page", () => {
  it("shows what is left while it runs, then emits exactly [] and reads usage and the trash again", async () => {
    const second = deferred<Response>();
    const answers = [() => json(remaining(240), 202), () => second.promise, NO_CONTENT];
    let emptied = false;
    const { calls } = await openTrash({
      "GET /api/trash": () => json(emptied ? trashPage([]) : TRASH),
      "GET /api/account/usage": () => json(emptied ? USAGE_AFTER_EMPTY : USAGE),
      "DELETE /api/trash": () => answers.shift()!(),
    });
    const usageBefore = usageCalls(calls);
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/^This can't be undone\. 3 items\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));
    const progress = document.querySelector("[data-empty-trash-progress]")!;
    await waitFor(() => expect(progress.textContent).toBe("Deleting… 240 left"));
    expect(progress.getAttribute("role")).toBe("status");
    expect(events).toEqual([]);
    emptied = true;
    second.resolve(json(remaining(40), 202));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trash is empty" })).toBeTruthy());
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(3);
    expect(events).toEqual([[]]);
    // Read again after each batch and once more at the end — and what is shown is the last answer.
    await waitFor(() => expect(usageCalls(calls)).toBeGreaterThan(usageBefore + 1));
    expect(progress.textContent).toBe("");
    expect(getToasts().map((toast) => toast.message)).toContain("Trash emptied");
  });

  it("an error stops it and says how many are left", async () => {
    const answers = [() => json(remaining(240), 202), () => envelope("internal", 500)];
    const { calls } = await openTrash({ "DELETE /api/trash": () => answers.shift()?.() });
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Empty trash" }));
    const stopped = await waitFor(() => {
      const found = document.querySelector("[data-empty-trash-stopped]");
      if (!found) throw new Error("not stopped yet");
      return found;
    });
    expect(stopped.textContent).toBe("Couldn't finish emptying the trash. 240 left. Try again.");
    expect(stopped.getAttribute("role")).toBe("alert");
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(2);
    // Part of it is gone: the numbers are read again.
    expect(events).toEqual([[]]);
  });
});

describe("leaving the page while the trash is being emptied", () => {
  it("the run goes on to its 204: the next page shows the same progress, and the list ends as the server has it", async () => {
    const second = deferred<Response>();
    let left = [...TRASH.items];
    let deletes = 0;
    const { calls, router } = await openView("/storage", {
      "GET /api/trash": () => json(trashPage(left)),
      "GET /api/account/usage": () => json(left.length === 0 ? USAGE_AFTER_EMPTY : USAGE),
      "DELETE /api/trash": () => {
        deletes += 1;
        if (deletes === 1) {
          left = left.slice(2);
          return json(remaining(1), 202);
        }
        if (deletes === 2) return second.promise;
        return NO_CONTENT();
      },
    });
    const storage = within(document.querySelector<HTMLElement>("[data-view-page='usage']")!);
    await waitFor(() =>
      expect((storage.getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(storage.getByRole("button", { name: "Empty trash" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Empty the trash?" })).getByRole("button", {
        name: "Empty trash",
      }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-empty-trash-progress]")!.textContent).toBe("Deleting… 1 left"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The user walks off mid-run, through the link next to the button.
    fireEvent.click(storage.getByRole("link", { name: "Open the trash" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/trash"));
    await waitFor(() => expect(document.querySelector("[data-view-page='trash']")).not.toBeNull());
    // Same run, same words, and the button cannot start a second one.
    expect(document.querySelector("[data-empty-trash-progress]")!.textContent).toBe("Deleting… 1 left");
    expect((screen.getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(true);
    // What is listed is what the server has: one of three.
    await waitFor(() => expect(rowNames()).toEqual([FOLDER.id]));
    expect(events).toEqual([]);

    left = [];
    second.resolve(json(remaining(0), 202));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trash is empty" })).toBeTruthy());
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(3);
    expect(events).toEqual([[]]);
    expect(getEmptyRun()).toEqual({ state: "idle" });
    expect(document.querySelector("[data-empty-trash-progress]")!.textContent).toBe("");
    expect(getToasts().map((toast) => toast.message)).toContain("Trash emptied");
  });

  it("a run that stops while nobody is on its page still says so, and the numbers are read again", async () => {
    const second = deferred<Response>();
    let deletes = 0;
    const { calls, router } = await openTrash({
      "DELETE /api/trash": () => (++deletes === 1 ? json(remaining(240), 202) : second.promise),
    });
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Empty trash" }));
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "running", remaining: 240 }));
    await act(() => router.navigate("/starred"));
    const usageBefore = usageCalls(calls);
    second.resolve(envelope("internal", 500));
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "stopped", remaining: 240, retryAt: 0 }));
    expect(getToasts().map((toast) => toast.message)).toContain(
      "Couldn't finish emptying the trash. 240 left. Try again.",
    );
    expect(events).toEqual([[]]);
    await waitFor(() => expect(usageCalls(calls)).toBeGreaterThan(usageBefore));
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(2);
  });

  it("a second start while one runs is ignored", async () => {
    const first = deferred<Response>();
    const calls = mockFetch((call) =>
      call.method === "DELETE" && pathOf(call) === "/api/trash" ? first.promise : undefined,
    );
    startEmptyTrash();
    startEmptyTrash();
    await waitFor(() => expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1));
    first.resolve(NO_CONTENT());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
  });
});

describe("an account switch that leaves the page mounted", () => {
  it("the run is stopped AND forgotten: no 'Deleting…' of the previous account, the button works again", async () => {
    const first = deferred<Response>();
    const { calls } = await openTrash({ "DELETE /api/trash": () => first.promise });
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Empty trash" }));
    const progress = () => document.querySelector("[data-empty-trash-progress]")!.textContent;
    await waitFor(() => expect(progress()).toBe("Deleting…"));
    await act(() => purgeUserState({ keepSession: true }));
    expect(getEmptyRun()).toEqual({ state: "idle" });
    await waitFor(() => expect(progress()).toBe(""));
    first.resolve(json(remaining(5), 202));
    await waitFor(() => expect(rowNames().length).toBeGreaterThan(0));
    expect(getEmptyRun()).toEqual({ state: "idle" });
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
    expect(events).toEqual([]);
    expect(document.querySelector("[data-empty-trash-stopped]")).toBeNull();
  });

  it("an open confirmation, the selection and the conflict notice of the first account are gone", async () => {
    await openTrash({ [`POST /api/nodes/${NOTES.id}/restore`]: () => envelope("conflict", 409) });
    openMenu("notes.txt");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(document.querySelector("[data-trash-conflict]")).not.toBeNull());
    fireEvent.click(screen.getByRole("checkbox", { name: "Select report.pdf" }));
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete forever/ }));
    expect(await screen.findByRole("dialog", { name: "Delete report.pdf forever?" })).toBeTruthy();
    // Another tab signed a different account in; this tab re-read the session.
    act(() => {
      queryClient.setQueryData(sessionQuery.queryKey, sessionOf({ id: "b".repeat(32), name: "Bo" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector("[data-trash-conflict]")).toBeNull();
    expect(document.querySelector("[data-selection-bar]")).toBeNull();
  });
});

describe("nothing of one account reaches the next through late work", () => {
  // Another account signs in (in another tab) while a request of this page is still out: the
  // state is purged, the session now names B, and the list that is read and shown is B's.
  // Whatever the late answer to A's request is, it writes nothing, says nothing, sends nothing.
  const switchAccount = async () => {
    await act(async () => {
      await purgeUserState({ keepSession: true });
      queryClient.setQueryData(sessionQuery.queryKey, sessionOf({ id: "b".repeat(32), name: "Bo" }));
    });
    await waitFor(() => expect(queryClient.getQueryState(viewKeys.trash)?.status).toBe("success"));
    await waitFor(() => expect(rowNames()).toHaveLength(3));
  };
  const lateRestore = async (answer: () => Response) => {
    const pending = deferred<Response>();
    const { calls } = await openView("/trash", {
      "GET /api/trash": TRASH,
      [`POST /api/nodes/${REPORT.id}/restore`]: () => pending.promise,
      [`POST /api/nodes/${NOTES.id}/restore`]: restored(NOTES),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    for (const name of ["report.pdf", "notes.txt"])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    fireEvent.click(
      within(document.querySelector<HTMLElement>("[data-selection-bar]")!).getByRole("button", {
        name: "Restore",
      }),
    );
    await waitFor(() => expect(requests(calls, "POST", `/api/nodes/${REPORT.id}/restore`)).toHaveLength(1));
    await switchAccount();
    pending.resolve(answer());
    await act(async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });
    return calls;
  };

  it("a restore answered 200 after the purge: the list in the cache is not patched, no toast, no event, the next item is not sent", async () => {
    const calls = await lateRestore(() => json(restored(REPORT)));
    const cached = queryClient.getQueryData<{ pages: Array<{ items: unknown[] }> }>(viewKeys.trash);
    expect(cached!.pages[0]!.items).toHaveLength(3);
    expect(rowNames()).toHaveLength(3);
    expect(getToasts()).toEqual([]);
    expect(events).toEqual([]);
    expect(requests(calls, "POST", `/api/nodes/${NOTES.id}/restore`)).toEqual([]);
  });

  it("a restore that fails after the purge is not announced", async () => {
    const calls = await lateRestore(() => envelope("internal", 500));
    expect(getToasts()).toEqual([]);
    expect(document.querySelector("[data-trash-conflict]")).toBeNull();
    expect(requests(calls, "POST", `/api/nodes/${NOTES.id}/restore`)).toEqual([]);
  });

  it("a refusal (409) that arrives after the purge shows no notice", async () => {
    await lateRestore(() => envelope("conflict", 409));
    expect(document.querySelector("[data-trash-conflict]")).toBeNull();
    expect(getToasts()).toEqual([]);
  });

  it("delete forever answered after the purge: nothing patched, said or emitted, and the next item is not deleted", async () => {
    const pending = deferred<Response>();
    const { calls } = await openView("/trash", {
      "GET /api/trash": TRASH,
      [`DELETE /api/nodes/${REPORT.id}`]: () => pending.promise,
      [`DELETE /api/nodes/${NOTES.id}`]: NO_CONTENT,
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    for (const name of ["report.pdf", "notes.txt"])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    fireEvent.click(
      within(document.querySelector<HTMLElement>("[data-selection-bar]")!).getByRole("button", {
        name: /Delete forever/,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete forever" }),
    );
    await waitFor(() => expect(requests(calls, "DELETE", `/api/nodes/${REPORT.id}`)).toHaveLength(1));
    await switchAccount();
    pending.resolve(NO_CONTENT());
    await act(async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });
    expect(
      queryClient.getQueryData<{ pages: Array<{ items: unknown[] }> }>(viewKeys.trash)!.pages[0]!.items,
    ).toHaveLength(3);
    expect(getToasts()).toEqual([]);
    expect(events).toEqual([]);
    expect(requests(calls, "DELETE", `/api/nodes/${NOTES.id}`)).toEqual([]);
  });

  it("the re-read before 'Empty the trash?' that answers after the purge opens no dialog", async () => {
    const pending = deferred<Response>();
    let hold = false;
    await openView("/trash", { "GET /api/trash": () => (hold ? pending.promise : json(TRASH)) });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    await act(() => purgeUserState({ keepSession: true }));
    hold = false;
    pending.resolve(json(TRASH));
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    await act(async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("review fixes on the trash page", () => {
  it("m1: a restore refused with anything but 409 reads the trash again — a row purged elsewhere goes", async () => {
    let purgedElsewhere = false;
    const { calls } = await openView("/trash", {
      "GET /api/trash": () =>
        json(trashPage(purgedElsewhere ? TRASH.items.filter((item) => item.id !== REPORT.id) : TRASH.items)),
      [`POST /api/nodes/${REPORT.id}/restore`]: () => envelope("not_found", 404),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const before = requests(calls, "GET", "/api/trash").length;
    purgedElsewhere = true;
    openMenu("report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(rowNames()).toEqual([NOTES.id, FOLDER.id]));
    expect(requests(calls, "GET", "/api/trash").length).toBe(before + 1);
    expect(getToasts().map((toast) => toast.requestId)).toContain("req-1234");
    expect(document.querySelector("[data-trash-conflict]")).toBeNull();
    expect(events).toEqual([]);
  });

  it("m3: the confirmation is opened with the trash as the server has it NOW, not as it was listed", async () => {
    let now = TRASH.items;
    const { calls } = await openView("/trash", { "GET /api/trash": () => json(trashPage(now)) });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const before = requests(calls, "GET", "/api/trash").length;
    // Meanwhile, on another device, the trash grew past the threshold.
    now = trashItems(101);
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(requests(calls, "GET", "/api/trash").length).toBe(before + 1);
    expect(within(dialog).getByText(/^This can't be undone\. 101 items\./)).toBeTruthy();
    expect(within(dialog).getByLabelText(`Type ${CONFIRM_WORD} to confirm`)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("m3: when that read fails the size is unknown — the word is asked for", async () => {
    let fail = false;
    await openView("/trash", {
      "GET /api/trash": () => (fail ? envelope("internal", 500) : json(TRASH)),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/Everything in the trash is deleted\./)).toBeTruthy();
    expect(within(dialog).getByLabelText(`Type ${CONFIRM_WORD} to confirm`)).toBeTruthy();
  });

  it("m3: offline, the confirmation opens at once with the size unknown — it does not wait for the connection", async () => {
    const { calls } = await openTrash();
    const before = requests(calls, "GET", "/api/trash").length;
    onlineManager.setOnline(false);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
      const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
      expect(within(dialog).getByLabelText(`Type ${CONFIRM_WORD} to confirm`)).toBeTruthy();
      expect(requests(calls, "GET", "/api/trash").length).toBe(before);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("a run stopped by a 429 cannot be started again before the time the API named", async () => {
    const { calls } = await openTrash({
      "DELETE /api/trash": () => envelope("rate_limited", 429, undefined, { "retry-after": "1" }),
    });
    const button = () => screen.getByRole("button", { name: "Empty trash" }) as HTMLButtonElement;
    fireEvent.click(button());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Empty trash" }));
    await waitFor(() => expect(getEmptyRun().state).toBe("stopped"));
    const run = getEmptyRun();
    expect(run.state === "stopped" && run.retryAt > Date.now()).toBe(true);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(button().disabled).toBe(true);
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
    // Enabled again when that second has passed — the wait is the API's, awaited as an event.
    await waitFor(() => expect(button().disabled).toBe(false), { timeout: 4000 });
  });

  it("m4: Delete does not open a second dialog over 'Empty the trash?', nor over the row menu", async () => {
    await openTrash();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select notes.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    openMenu("report.pdf");
    await screen.findByRole("menu");
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // With nothing open the key works as before.
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(await screen.findByRole("dialog", { name: "Delete notes.txt forever?" })).toBeTruthy();
  });

  it("m6: one row loaded and more to come is 'More than 1 item', in the count and in the confirmation", async () => {
    await openView("/trash", { "GET /api/trash": trashPage([REPORT], "next") });
    await waitFor(() => expect(rowNames()).toHaveLength(1));
    expect(document.querySelector("[data-trash-count]")!.textContent).toBe("More than 1 item");
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/^This can't be undone\. More than 1 item\. /)).toBeTruthy();
    expect(dialog.textContent).not.toContain("1 items");
  });
});

describe("mobile", () => {
  it("row actions open in a bottom sheet", async () => {
    await openTrash({ [`POST /api/nodes/${REPORT.id}/restore`]: restored(REPORT) }, 390);
    expect(document.querySelector("[data-frame]")!.getAttribute("data-frame")).toBe("mobile");
    openMenu("report.pdf");
    const sheet = await screen.findByRole("dialog", { name: "report.pdf" });
    expect(sheet.className).toContain("MuiDrawer-paper");
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(rowNames()).not.toContain(REPORT.id));
  });

  it("a long press selects, and the selection bar offers the two actions", async () => {
    await openTrash({}, 390);
    const row = document.querySelector<HTMLElement>(`[data-item-id="${NOTES.id}"]`)!;
    vi.useFakeTimers();
    fireEvent.pointerDown(row, { pointerType: "touch" });
    // Shorter than a long press: nothing yet.
    act(() => vi.advanceTimersByTime(400));
    expect(row.getAttribute("aria-selected")).not.toBe("true");
    act(() => vi.advanceTimersByTime(200));
    vi.useRealTimers();
    expect(row.getAttribute("aria-selected")).toBe("true");
    const bar = document.querySelector<HTMLElement>("[data-selection-bar]")!;
    expect(within(bar).getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Delete forever" })).toBeTruthy();
  });
});
