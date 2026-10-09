// Ids for rows of OUR tables: UUID version 7 (RFC 9562), generated in the application.
//
// A v7 id starts with a 48-bit millisecond timestamp, so ids sort roughly by creation time and
// index pages fill in order. Postgres 17 has no `uuidv7()` of its own.
//
// Never used for a `user` or `session` id: those are Better Auth's own 32-character strings,
// held in `text` columns.

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

/** A new UUID v7 in the canonical lower-case form. `now` is injectable for tests. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 48-bit big-endian Unix time in milliseconds.
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i]!];
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for any canonical UUID. Guards values before they reach a `uuid` column comparison. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
