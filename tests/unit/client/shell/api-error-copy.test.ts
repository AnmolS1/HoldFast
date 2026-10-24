// R1 integration (Addendum 3): the error codes added in R1 that a person can meet each reach the
// screen in the client's own words (src/client/lib/en.ts `apiError.<code>`) — not the generic
// failure, and not the server's provisional text. Every surface that shows `ApiError.message`
// (the standard toast, the upload row, the admin console's refusal line, the deletion banner and
// Settings) therefore says the same thing.
import { describe, expect, it } from "vitest";
import { toApiError, toastApiError } from "../../../../src/client/lib/api";
import { en } from "../../../../src/client/lib/en";
import { getToasts } from "../../../../src/client/components/Toaster";
import { setupShell } from "./helpers";

setupShell();

const SERVER_WORDS = "made-up server text";

const answer = (code: string, status: number) =>
  new Response(JSON.stringify({ error: code, message: SERVER_WORDS, requestId: "req-made-up" }), {
    status,
    headers: { "content-type": "application/json" },
  });

const CASES = [
  ["body_too_large", 413, en["apiError.body_too_large"]],
  ["replace_in_progress", 409, en["apiError.replace_in_progress"]],
  ["self_action", 400, en["apiError.self_action"]],
  ["last_admin", 409, en["apiError.last_admin"]],
  ["deletion_admin_scheduled", 409, en["apiError.deletion_admin_scheduled"]],
] as const;

describe("the R1 error codes in the client's own words", () => {
  it.each(CASES)("%s (%i) → its own sentence, the request id kept", async (code, status, sentence) => {
    const error = await toApiError(answer(code, status));
    expect([error.code, error.status, error.requestId]).toEqual([code, status, "req-made-up"]);
    expect(error.message).toBe(sentence);
    expect(error.message).not.toBe(en["toast.generic"]);
    expect(error.message).not.toBe(SERVER_WORDS);
  });

  it("the standard toast shows that sentence", async () => {
    toastApiError(await toApiError(answer("body_too_large", 413)));
    expect(getToasts().map((toast) => toast.message)).toEqual([en["apiError.body_too_large"]]);
  });

  it("other known codes keep the server's words (unchanged)", async () => {
    const error = await toApiError(answer("conflict", 409));
    expect(error.message).toBe(SERVER_WORDS);
  });

  it("the deletion sentence is the one the banner and Settings show", () => {
    expect(en["apiError.deletion_admin_scheduled"]).toBe(en["banner.deletion.adminScheduled"]);
  });
});
