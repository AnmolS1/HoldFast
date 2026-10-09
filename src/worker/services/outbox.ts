// The in-memory mail outbox behind EMAIL_TRANSPORT=memory: the last 200 messages "sent" by this
// isolate, read by tests through GET /api/_test/outbox. Module scope on purpose — it only works
// in a single isolate, which is what `vite dev` and the vitest plugin provide. Nothing is sent.

export type OutboxMessage = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  [field: string]: unknown;
};

export const OUTBOX_CAPACITY = 200;

const messages: OutboxMessage[] = [];

export function push(message: OutboxMessage): void {
  messages.push(message);
  if (messages.length > OUTBOX_CAPACITY) messages.splice(0, messages.length - OUTBOX_CAPACITY);
}

/** Oldest first. `to` filters by recipient, case-insensitively, on a substring match. */
export function list(filter: { to?: string } = {}): OutboxMessage[] {
  const needle = filter.to?.toLowerCase();
  if (!needle) return [...messages];
  return messages.filter((message) => {
    const recipients = Array.isArray(message.to) ? message.to : [message.to];
    return recipients.some((recipient) => String(recipient).toLowerCase().includes(needle));
  });
}

export function clear(): void {
  messages.length = 0;
}
