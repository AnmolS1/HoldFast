// One owner per verdict (R1 a11y-3): a blocked or couldn't-scan verdict of a file the upload queue
// follows is said ONCE, in the upload log — whoever learns it first: the queue's own loop, the
// explorer's poll, or a refetch of the listing — and the explorer's own region stays quiet for it
// (`scanVerdictOwned`). A loop answer still on its way after the row settled says nothing more.
// And a drop of more than a few files is not said file by file (a11y-11).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addFiles, scanVerdictOwned, scanVerdictsSeen } from "../../../../src/client/features/upload/manager";
import { SAY_EACH_FILE_MAX, VERDICT_CLAIM_MS } from "../../../../src/client/features/upload/plan";
import { getUploads } from "../../../../src/client/features/upload/store";
import * as contracts from "../../../../src/client/lib/contracts";
import { purgeUserState } from "../../../../src/client/lib/query";
import { setupShell } from "../shell/helpers";
import { nodeDto } from "./fixtures";
import {
  FAKED_TIMERS,
  freshUploader,
  installServer,
  json,
  SCAN_ASK,
  scanAsks,
  settle,
  smallFile,
  type Server,
  askIds,
} from "./helpers";

setupShell();

let server: Server;
/** The loop's request on its way, when held: answer it with these verdicts. */
let held: ((status: string) => void) | null;
let holding: boolean;

beforeEach(async () => {
  await freshUploader();
  server = installServer();
  server.scanStatus = "pending";
  held = null;
  holding = false;
  server.onJson = (call) => {
    if (!holding || call.method !== "GET" || !SCAN_ASK.test(call.path)) return undefined;
    const ids = askIds(call);
    return new Promise<Response>((resolve) => {
      held = (status) =>
        resolve(
          json({
            items: ids.map((id) => nodeDto({ id, name: "a.txt", scanStatus: status as "infected" })),
          }),
        );
    });
  };
  vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
});

const said = () => getUploads().announcements.map((entry) => entry.text);
const BLOCKED = "a.txt was blocked — flagged by the malware scan";
const blockedSaid = () => said().filter((text) => text === BLOCKED).length;

async function landOne(): Promise<string> {
  await addFiles([{ file: smallFile("a.txt") }], null);
  for (let turn = 0; turn < 20 && getUploads().items[0]?.state !== "scanning"; turn += 1) await settle(0);
  return getUploads().items[0]!.nodeId!;
}
const verdict = (id: string, etag = "v1") => nodeDto({ id, name: "a.txt", scanStatus: "infected", etag });

describe("a blocked verdict is said once, whoever learns it first", () => {
  it("the loop first; then the explorer's poll answer that was on its way: the explorer leaves it to the queue", async () => {
    const id = await landOne();
    server.scanStatus = "infected";
    await settle(1_000);
    expect(blockedSaid()).toBe(1);
    // The explorer's answer arrives: the queue said it.
    expect(scanVerdictOwned(verdict(id))).toBe(true);
    // Its patch of the listing reaches the queue: nothing more is said.
    scanVerdictsSeen([verdict(id)]);
    expect(blockedSaid()).toBe(1);
  });

  it("the explorer's poll first: the explorer leaves it to the queue, which says it from the listing; the loop's answer on its way then says nothing", async () => {
    const id = await landOne();
    holding = true;
    await settle(1_000);
    expect(scanAsks(server)).toHaveLength(1);
    // The explorer's poll learns the verdict while the loop's request is on its way.
    expect(scanVerdictOwned(verdict(id))).toBe(true);
    scanVerdictsSeen([verdict(id)]);
    expect(blockedSaid()).toBe(1);
    held!("infected");
    await settle(0);
    expect(blockedSaid()).toBe(1);
    expect(getUploads().items[0]).toMatchObject({ state: "done", scanStatus: "infected" });
  });

  it("a refetch of the listing first: said once; the loop's answer on its way says nothing", async () => {
    const id = await landOne();
    holding = true;
    await settle(1_000);
    scanVerdictsSeen([verdict(id)]);
    held!("infected");
    await settle(0);
    expect(blockedSaid()).toBe(1);
    expect(said().filter((text) => text.startsWith("Couldn't scan"))).toEqual([]);
  });

  it("couldn't scan: the same", async () => {
    const id = await landOne();
    holding = true;
    await settle(1_000);
    scanVerdictsSeen([{ ...verdict(id), scanStatus: "error", scanReason: "engine" }]);
    held!("error");
    await settle(0);
    expect(said().filter((text) => text === "Couldn't scan a.txt")).toHaveLength(1);
  });
});

describe("through lib/contracts, as the explorer asks", () => {
  it("a file landed: the queue owns its verdict and takes the listing's; after the purge nothing is the queue's", async () => {
    const id = await landOne();
    expect(contracts.scanVerdictOwned(verdict(id))).toBe(true);
    contracts.scanVerdictsSeen([verdict(id)]);
    expect(blockedSaid()).toBe(1);
    await purgeUserState({ keepSession: true });
    await settle(0);
    expect(contracts.scanVerdictOwned(verdict(id))).toBe(false);
  });
});

describe("what the explorer still says itself", () => {
  it("a file the queue never followed, another version of it, a claim older than VERDICT_CLAIM_MS, and anything after the account changed", async () => {
    const id = await landOne();
    expect(scanVerdictOwned(verdict("0192f000-0000-7000-8000-00000000abcd"))).toBe(false);
    expect(scanVerdictOwned(verdict(id, "v0"))).toBe(false);
    server.scanStatus = "infected";
    await settle(1_000);
    await settle(VERDICT_CLAIM_MS);
    expect(scanVerdictOwned(verdict(id))).toBe(false);
  });

  it("a claim is taken once: a later scan of the same file (Re-check in the explorer) is the explorer's to say", async () => {
    const id = await landOne();
    server.scanStatus = "infected";
    await settle(1_000);
    expect(scanVerdictOwned(verdict(id))).toBe(true);
    expect(scanVerdictOwned(verdict(id))).toBe(false);
  });

  it("after the account changed nothing is the queue's", async () => {
    const id = await landOne();
    server.scanStatus = "infected";
    await settle(1_000);
    await purgeUserState({ keepSession: true });
    await settle(0);
    expect(scanVerdictOwned(verdict(id))).toBe(false);
  });
});

describe("a11y-11: a larger drop is told by the ribbon, not file by file", () => {
  it(`${SAY_EACH_FILE_MAX} files: each said; ${SAY_EACH_FILE_MAX + 1}: none of the uploading/uploaded sentences — a verdict still is`, async () => {
    server.scanStatus = "clean";
    await addFiles(
      Array.from({ length: SAY_EACH_FILE_MAX }, (_, n) => ({ file: smallFile(`s${n}.txt`) })),
      null,
    );
    await settle();
    expect(said().filter((text) => /^Uploading s\d|^s\d\.txt uploaded$/.test(text))).toHaveLength(
      2 * SAY_EACH_FILE_MAX,
    );
    server.scanStatus = "infected";
    await addFiles(
      Array.from({ length: SAY_EACH_FILE_MAX + 1 }, (_, n) => ({ file: smallFile(`m${n}.txt`) })),
      null,
    );
    await settle();
    await settle(1_000);
    expect(said().filter((text) => /^Uploading m\d|^m\d\.txt uploaded$/.test(text))).toEqual([]);
    expect(said().filter((text) => / was blocked /.test(text))).toHaveLength(SAY_EACH_FILE_MAX + 1);
  });
});
