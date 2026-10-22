// The DMCA designated agent (17 U.S.C. §512(c)(2)): the details the website must show, EXACTLY as
// registered in the Copyright Office's DMCA Designated Agent Directory.
//
// NOT REGISTERED YET (T29 §B.1 is Anmol's step; deferred to Gate B). Until the registration is done
// every field carries the `TODO_` sentinel, and the page renders it as it is: the Gate-B checks fail
// while it does (tests/e2e/dmca.spec.ts's agent-details test skips, and a skip fails the gate run;
// verify-gate-b.sh greps this file). Never put a guessed name, address or phone here.
//
// Plain data on purpose: the e2e spec imports this file in Node.

export const SENTINEL = "TODO_";

export interface DesignatedAgent {
  name: string;
  /** Postal address, as one string (line breaks with "\n"). */
  address: string;
  phone: string;
  email: string;
}

export const AGENT_FIELDS = ["name", "address", "phone", "email"] as const satisfies ReadonlyArray<
  keyof DesignatedAgent
>;

export const AGENT: DesignatedAgent = {
  name: "TODO_AGENT_NAME",
  address: "TODO_AGENT_POSTAL_ADDRESS",
  phone: "TODO_AGENT_PHONE",
  email: "TODO_AGENT_EMAIL",
};

/** True while any field still carries the sentinel. */
export function hasSentinel(agent: DesignatedAgent): boolean {
  return AGENT_FIELDS.some((field) => agent[field].includes(SENTINEL));
}

export const agentHasSentinel = hasSentinel(AGENT);
