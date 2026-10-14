// A component's own state must not outlive the account it belongs to: the frame remounts
// everything inside it when the signed-in account changes without a navigation.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { SessionShape } from "../../../../src/client/lib/contracts";
import { purgeUserState, queryClient, refreshSession } from "../../../../src/client/lib/query";
import { AccountKeyed } from "../../../../src/client/routes/frame/Frame";
import { renderShell, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const ALICE = sessionOf({ id: "a".repeat(32), name: "Alice", email: "alice@example.com" });
const BOB = sessionOf({ id: "b".repeat(32), name: "Bob", email: "bob@example.com" });

function Holder() {
  const [held, setHeld] = useState("nothing");
  return (
    <button type="button" data-held={held} onClick={() => setHeld("alice's file")}>
      hold
    </button>
  );
}

const held = () => screen.getByRole("button").getAttribute("data-held");

describe("AccountKeyed", () => {
  it("keeps a component's state for the same account and throws it away for another", async () => {
    let current: SessionShape = ALICE;
    shellFetch({ session: () => current });
    queryClient.setQueryData(["session"], ALICE);
    renderShell(
      <AccountKeyed>
        <Holder />
      </AccountKeyed>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(held()).toBe("alice's file");

    // The same account read again (a refresh): nothing is lost.
    await refreshSession();
    expect(held()).toBe("alice's file");

    // Another account, no navigation: the component is new.
    current = BOB;
    await refreshSession();
    await waitFor(() => expect(held()).toBe("nothing"));

    // An EXPIRED session (read as null, nothing purged) is not another account: state is kept, so
    // a re-auth as the same account goes on where it was.
    fireEvent.click(screen.getByRole("button"));
    expect(held()).toBe("alice's file");
    current = null;
    await refreshSession();
    // Observers are told on a later macrotask: wait for it before looking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held()).toBe("alice's file");
    current = BOB;
    await refreshSession();
    await waitFor(() => expect(held()).toBe("alice's file"));

    // A real sign-out purges the remembered account: that is another identity.
    current = null;
    await purgeUserState();
    await refreshSession();
    await waitFor(() => expect(held()).toBe("nothing"));
  });
});
