// PLACEHOLDER — taken over by the auth task, which replaces this file with the real Better Auth
// client (createAuthClient + passkey, two-factor and admin plugins) satisfying the same contract.
// Until then every method rejects, so nothing can look signed in by accident.
import { AUTH_NOT_WIRED, type AuthClientContract } from "./auth-contract";

function notWired(): Promise<never> {
  return Promise.reject(new Error(AUTH_NOT_WIRED));
}

export const authClient: AuthClientContract = {
  signIn: { email: notWired, social: notWired, passkey: notWired },
  signUp: { email: notWired },
  signOut: notWired,
  sendVerificationEmail: notWired,
  requestPasswordReset: notWired,
  resetPassword: notWired,
  twoFactor: { verifyTotp: notWired, verifyBackupCode: notWired },
  admin: { stopImpersonating: notWired },
};
