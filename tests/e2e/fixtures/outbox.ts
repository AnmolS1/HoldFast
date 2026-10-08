// Reads mail the local Worker "sent". With EMAIL_TRANSPORT=memory nothing leaves the machine: the
// Worker keeps the last 200 messages in memory and serves them at GET /api/_test/outbox
// (`?to=<address>` filters, `?clear=1` empties it). The route does not exist with any other
// transport or in production.
import { request } from "@playwright/test";
import { appOrigin, e2ePort } from "../../setup/local-env";

export interface OutboxMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  [field: string]: unknown;
}

export interface LatestMailOptions {
  /** Only a message whose subject contains this text or matches this pattern. */
  subject?: string | RegExp;
  /** How long to wait for it. Mail is sent after the response, so it can lag a request. */
  timeoutMs?: number;
}

function messagesIn(body: unknown): OutboxMessage[] {
  if (Array.isArray(body)) return body as OutboxMessage[];
  if (body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)) {
    return (body as { messages: OutboxMessage[] }).messages;
  }
  throw new Error("outbox: unexpected response shape (expected an array, or an object with `messages`)");
}

function isTo(message: OutboxMessage, address: string): boolean {
  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  return recipients.some((r) => String(r).toLowerCase().includes(address.toLowerCase()));
}

async function fetchOutbox(query: Record<string, string>): Promise<OutboxMessage[]> {
  const context = await request.newContext({ baseURL: appOrigin(e2ePort()) });
  try {
    const response = await context.get("/api/_test/outbox", { params: query });
    if (response.status() !== 200) {
      throw new Error(
        `outbox: GET /api/_test/outbox answered ${response.status()} — it exists only when the ` +
          `Worker runs with EMAIL_TRANSPORT=memory (check this checkout's .dev.vars)`,
      );
    }
    return messagesIn(await response.json());
  } finally {
    await context.dispose();
  }
}

/** The newest message sent to `address`. Waits for it; throws when none arrives in time. */
export async function latestMailTo(address: string, options: LatestMailOptions = {}): Promise<OutboxMessage> {
  const { subject, timeoutMs = 10_000 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = (await fetchOutbox({ to: address })).filter((message) => {
      if (!isTo(message, address)) return false;
      if (subject === undefined) return true;
      return typeof subject === "string" ? message.subject.includes(subject) : subject.test(message.subject);
    });
    const latest = messages.at(-1);
    if (latest) return latest;
    if (Date.now() >= deadline) {
      throw new Error(
        `outbox: no mail to ${address}${subject ? ` matching ${String(subject)}` : ""} within ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Every http(s) link in a message, in order (verification and reset links). */
export function linksIn(message: OutboxMessage): string[] {
  const body = `${message.html ?? ""}\n${message.text ?? ""}`;
  const links = body.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(links.map((link) => link.replaceAll("&amp;", "&")))];
}

/** Empties the outbox. */
export async function clearOutbox(): Promise<void> {
  await fetchOutbox({ clear: "1" });
}
