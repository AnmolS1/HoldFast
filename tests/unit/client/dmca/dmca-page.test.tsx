// The public /dmca page (T29 §B.2): the designated agent as registered, the elements of a notice
// (§512(c)(3)), the counter-notice and its 10–14 business-day window (§512(g)), and the
// repeat-infringer policy from T10's constants — signed out, outside the frame, reading no session.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../../../src/shared/constants";
import { buildRoutes } from "../../../../src/client/router";
import {
  AGENT,
  AGENT_FIELDS,
  agentHasSentinel,
  hasSentinel,
  SENTINEL,
} from "../../../../src/client/features/dmca/agent";
import { DmcaPage } from "../../../../src/client/features/dmca/DmcaPage";
import { renderRoutes, setupShell, shellFetch } from "../shell/helpers";

setupShell();

describe("agent.ts — the designated agent's details as data", () => {
  // THE SENTINEL. Anmol has not registered the agent with the Copyright Office yet (T29 §B.1,
  // deferred to Gate B on 2026-10-22). Until he supplies the details exactly as registered, every
  // field carries `TODO_`; the page says the registration is pending, and the Gate-B checks fail:
  // the @prod-safe agent-details test in tests/e2e/dmca.spec.ts skips (and a skip fails the gate
  // run), and verify-gate-b.sh will grep agent.ts once T30 writes it. When the details arrive:
  // replace the four values in agent.ts AND, in the same commit, flip this first test (every field
  // must then NOT match /^TODO_/, `agentHasSentinel` false) — it goes red on filled details by design.
  it("carries the TODO_ sentinel in every field until the registration is done", () => {
    expect(SENTINEL).toBe("TODO_");
    expect(AGENT_FIELDS).toEqual(["name", "address", "phone", "email"]);
    for (const field of AGENT_FIELDS) expect(AGENT[field], field).toMatch(/^TODO_/);
    expect(agentHasSentinel).toBe(true);
  });

  it("hasSentinel: any one field still carrying TODO_ counts; made-up complete details do not", () => {
    // Obviously made-up details, only to show the predicate.
    const complete = {
      name: "Example Agent",
      address: "1 Example St",
      phone: "+1 555 0100",
      email: "a@example.test",
    };
    expect(hasSentinel(complete)).toBe(false);
    for (const field of AGENT_FIELDS) {
      expect(hasSentinel({ ...complete, [field]: `TODO_${field}` }), field).toBe(true);
      expect(hasSentinel({ ...complete, [field]: `x TODO_ y` }), field).toBe(true);
    }
  });
});

describe("/dmca", () => {
  async function open() {
    const calls = shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/dmca"]);
    const heading = await screen.findByRole("heading", { level: 1, name: "Copyright and DMCA" });
    return { calls, heading };
  }

  it("renders signed out, outside the frame, in a main landmark, and reads nothing from the API", async () => {
    const { calls, heading } = await open();
    expect(document.querySelector("[data-frame]")).toBeNull();
    const main = screen.getByRole("main");
    expect(main.contains(heading)).toBe(true);
    expect(screen.getByRole("navigation", { name: "Legal" })).toBeTruthy();
    expect(calls.map((call) => call.path)).toEqual([]);
    // One h1; every section is an h2 under it.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Designated agent",
      "Sending a notice",
      "Counter-notice",
      "Repeat infringers",
      "False claims",
    ]);
  });

  // Anmol's choice (DEMONOTICE, 2026-10-22): while agent.ts carries the sentinel the page says the
  // registration is pending — not a single `TODO_` reaches the DOM (text or attribute). The Gate-B
  // checks still fail on agent.ts itself; this only changes what the public sees meanwhile.
  // Made-up details with the sentinel in one field only, so this test holds before AND after agent.ts
  // is filled (the e2e test checks the real AGENT in either state).
  it("while the agent carries the sentinel: says the registration is pending, and no TODO_ reaches the DOM", async () => {
    const pending = {
      name: "Example Agent",
      address: "1 Example St",
      phone: "+1 555 0100",
      email: `${SENTINEL}EMAIL`,
    };
    shellFetch({ session: null });
    renderRoutes([{ path: "/dmca", element: <DmcaPage agent={pending} /> }], ["/dmca"]);
    const agent = await screen.findByRole("region", { name: "Designated agent" });
    expect(agent.textContent).toContain("Designated agent registration pending");
    expect(agent.querySelector("[data-dmca-agent]")).toBeNull();
    expect(within(agent).queryByRole("link")).toBeNull();
    // The whole document, attributes included (a mailto: href is not text).
    expect(document.documentElement.outerHTML).not.toContain(SENTINEL);
    expect(document.body.textContent).not.toContain("Example Agent");
    // The rest of the page is as built.
    expect(screen.getByRole("region", { name: "Sending a notice" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Counter-notice" })).toBeTruthy();
  });

  it("with the details filled: shows the agent's name, address, phone and email, the email as a mailto link", async () => {
    // Obviously made-up details: the page as it will be once agent.ts is filled.
    const filled = {
      name: "Example Agent",
      address: "1 Example St\nSpringfield, XX 00000",
      phone: "+1 555 0100",
      email: "agent@example.test",
    };
    shellFetch({ session: null });
    renderRoutes([{ path: "/dmca", element: <DmcaPage agent={filled} /> }], ["/dmca"]);
    const agent = await screen.findByRole("region", { name: "Designated agent" });
    expect(agent.textContent).not.toContain("registration pending");
    const details = agent.querySelector("[data-dmca-agent]")!.textContent ?? "";
    // The address may run over several lines ("\n" in agent.ts): each line is shown.
    for (const field of AGENT_FIELDS) {
      for (const line of filled[field].split("\n")) expect(details, field).toContain(line);
    }
    const mail = within(agent).getByRole("link", { name: filled.email });
    expect(mail.getAttribute("href")).toBe(`mailto:${filled.email}`);
  });

  it("lists the six elements of a notice (§512(c)(3)(A)), the signature among them", async () => {
    await open();
    const section = screen.getByRole("region", { name: "Sending a notice" });
    const items = within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(items).toHaveLength(6);
    expect(items.join("\n")).toMatch(/signature/i);
    expect(items.join("\n")).toMatch(/good[- ]faith belief/i);
    expect(items.join("\n")).toMatch(/penalty of perjury/i);
  });

  it("says who is told of a takedown: the person who uploaded it, and the folder's owner when that is someone else (R1 ruling Q2)", async () => {
    await open();
    const section = screen.getByRole("region", { name: "Sending a notice" });
    expect(section.textContent).toContain(
      "tell the person who uploaded it, with a copy of the notice's description of the material and how to send a counter-notice. If someone else owns the folder it was in, we tell them too.",
    );
    expect(section.textContent).not.toContain("tell the account owner");
  });

  it("explains the counter-notice: its four elements, the consent to jurisdiction, and the 10–14 business-day window", async () => {
    await open();
    const section = screen.getByRole("region", { name: "Counter-notice" });
    const items = within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(items).toHaveLength(4);
    expect(items.join("\n")).toMatch(/consent to the jurisdiction/i);
    expect(section.textContent).toMatch(/not less than 10 and not more than 14 business days/);
  });

  it("states the repeat-infringer policy with T10's numbers", async () => {
    await open();
    const section = screen.getByRole("region", { name: "Repeat infringers" });
    expect(section.textContent).toContain(`${STRIKES_TO_SUSPEND} strikes`);
    expect(section.textContent).toContain(`${STRIKE_WINDOW_DAYS} days`);
  });
});
