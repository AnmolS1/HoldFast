// "Sign in again": the server wants a newer session (SESSION_NOT_FRESH). The browser is signed out,
// everything of the account is dropped, and the sign-in page brings the person back here.
import { useNavigate } from "react-router";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { purgeUserState } from "../../lib/query";

export function useSignInAgain(): () => Promise<void> {
  const navigate = useNavigate();
  return async () => {
    const back = `${window.location.pathname}${window.location.search}`;
    await callAuth(() => authClient.signOut());
    await purgeUserState();
    navigate(`/login?next=${encodeURIComponent(back)}`, { replace: true });
  };
}
