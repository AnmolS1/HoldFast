// The two functions that do password-hashing work (scrypt), in one module of their own.
//
// They are Better Auth's own (better-auth/crypto) and are handed back to it unchanged through
// `emailAndPassword.password`. The module exists so that a test can count how often each runs:
// "an address with an account and one without cost the same hashing work" is asserted on these
// calls (tests/unit/auth/enumeration.test.ts), not on a clock.
import { hashPassword as betterAuthHash, verifyPassword as betterAuthVerify } from "better-auth/crypto";

export const hashPassword = (password: string): Promise<string> => betterAuthHash(password);

export const verifyPassword = (data: { hash: string; password: string }): Promise<boolean> =>
  betterAuthVerify(data);
