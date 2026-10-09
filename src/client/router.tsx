// The route tree (seam: orchestrator-only after the shell task). React Router 7 data mode.
//
//   auth screens        /login /signup /verify-email /forgot-password /reset-password /two-factor /invite/:code
//   legal gate          /accept-terms                (signed in; outside the frame)
//   app frame           / + featureRoutes + /help    (session → verified → terms; admin role for /admin/*)
//   public routes       /s/:token /dmca …            (outside the frame and outside every guard)
//   not found           *
//
// A feature never edits this file: it exports `routes` from `features/<name>/routes.tsx`.
import {
  createBrowserRouter,
  Outlet,
  redirect,
  type LoaderFunctionArgs,
  type RouteObject,
} from "react-router";
import type { RouteHandle } from "./components/slots";
import { featureRoutes, publicRoutes, routeHandle } from "./features";
import { configureApi } from "./lib/api";
import type { PublicConfig, SessionShape } from "./lib/contracts";
import { t } from "./lib/i18n";
import { publicConfigQuery, queryClient, sessionQuery } from "./lib/query";
import { initSentry } from "./lib/sentry";
import {
  AuthLayout,
  ForgotPasswordPage,
  InvitePage,
  LoginPage,
  ResetPasswordPage,
  safeNext,
  SignupPage,
  TwoFactorPage,
  VerifyEmailPage,
} from "./routes/auth";
import { Frame } from "./routes/frame/Frame";
import { HelpPage } from "./routes/help";
import { AcceptTermsPage } from "./routes/legal-gate";
import { NotFoundPage, RouteErrorPage, StartingPage } from "./routes/not-found";

async function loadConfig(): Promise<PublicConfig> {
  const config = await queryClient.fetchQuery(publicConfigQuery);
  // Reporting starts once the config is known, and only when it carries a DSN.
  void initSentry(config);
  return config;
}

function loadSession(): Promise<SessionShape> {
  return queryClient.fetchQuery(sessionQuery);
}

function pathOf(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search + url.hash;
}

function termsStale(session: NonNullable<SessionShape>, config: PublicConfig): boolean {
  return session.user.termsVersion !== config.termsVersion;
}

/** The frame's guard: signed in → verified → current terms. */
export async function requireUser({ request }: LoaderFunctionArgs): Promise<null> {
  const [session, config] = await Promise.all([loadSession(), loadConfig()]);
  const here = pathOf(request);
  if (!session) throw redirect(`/login?next=${encodeURIComponent(here)}`);
  if (!session.user.emailVerified) throw redirect("/verify-email");
  if (termsStale(session, config)) throw redirect(`/accept-terms?next=${encodeURIComponent(here)}`);
  return null;
}

/** `/admin/*`: anyone who is not an admin gets the same page as an address that does not exist. */
export async function requireAdmin(): Promise<null> {
  const session = await loadSession();
  if (session?.user.role !== "admin") throw new Response(null, { status: 404 });
  return null;
}

/** Auth screens: a signed-in, verified user has no business here and is sent on to `next`. */
export async function redirectSignedIn({ request }: LoaderFunctionArgs): Promise<null> {
  const [session] = await Promise.all([loadSession(), loadConfig()]);
  if (session?.user.emailVerified) {
    const url = new URL(request.url);
    throw redirect(safeNext(url.searchParams.get("next"), url.origin));
  }
  return null;
}

/** `/verify-email` is reachable signed out (right after sign-up) and by an unverified session. */
export async function verifyEmailGuard(): Promise<null> {
  const [session] = await Promise.all([loadSession(), loadConfig()]);
  if (session?.user.emailVerified) throw redirect("/");
  return null;
}

/** `/accept-terms`: needs a session; with current terms there is nothing to accept. */
export async function termsGuard({ request }: LoaderFunctionArgs): Promise<null> {
  const [session, config] = await Promise.all([loadSession(), loadConfig()]);
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), url.origin);
  if (!session) throw redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!termsStale(session, config)) throw redirect(next);
  return null;
}

const isAdminRoute = (route: RouteObject) =>
  route.path === "admin" || Boolean(route.path?.startsWith("admin/"));
const isOverlay = (route: RouteObject) => routeHandle(route).overlay === true;

const auth: RouteHandle = { auth: true };

/** Built by a function so tests can make a fresh tree; the app builds it once. */
export function buildRoutes(): RouteObject[] {
  const adminRoutes = featureRoutes.filter(isAdminRoute);
  const plainRoutes = featureRoutes.filter((route) => !isAdminRoute(route));
  const helpRoute: RouteObject = {
    path: "help",
    element: <HelpPage />,
    handle: { title: t("nav.help"), details: false },
  };
  const frameChildren: RouteObject[] = [
    ...plainRoutes,
    helpRoute,
    ...(adminRoutes.length > 0
      ? [{ id: "admin-guard", loader: requireAdmin, element: <Outlet />, children: adminRoutes }]
      : []),
  ];
  // What a cold overlay link shows underneath: every in-frame page that is not itself an overlay
  // and has no role guard of its own.
  const backgroundRoutes = [...plainRoutes.filter((route) => !isOverlay(route)), helpRoute];

  return [
    {
      id: "root",
      errorElement: <RouteErrorPage />,
      // Shown while the first guard (session + config) is still loading.
      HydrateFallback: StartingPage,
      children: [
        {
          id: "auth",
          element: <AuthLayout />,
          children: [
            { path: "login", loader: redirectSignedIn, element: <LoginPage />, handle: auth },
            { path: "signup", loader: redirectSignedIn, element: <SignupPage />, handle: auth },
            { path: "invite/:code", loader: redirectSignedIn, element: <InvitePage />, handle: auth },
            { path: "verify-email", loader: verifyEmailGuard, element: <VerifyEmailPage />, handle: auth },
            {
              path: "forgot-password",
              loader: redirectSignedIn,
              element: <ForgotPasswordPage />,
              handle: auth,
            },
            {
              path: "reset-password",
              loader: redirectSignedIn,
              element: <ResetPasswordPage />,
              handle: auth,
            },
            { path: "two-factor", loader: redirectSignedIn, element: <TwoFactorPage />, handle: auth },
          ],
        },
        { path: "accept-terms", loader: termsGuard, element: <AcceptTermsPage />, handle: auth },
        {
          id: "frame",
          path: "/",
          loader: requireUser,
          element: <Frame backgroundRoutes={backgroundRoutes} />,
          children: frameChildren,
        },
        // Public pages: no loader, no session read, no frame.
        ...publicRoutes,
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ];
}

type AppRouter = ReturnType<typeof createBrowserRouter>;

/** Tell the API client which kind of route is showing and how to navigate. */
export function connectRouter(router: Pick<AppRouter, "state" | "navigate">): void {
  configureApi({
    routeInfo: () => {
      const handles = router.state.matches.map((match) => (match.route.handle ?? {}) as RouteHandle);
      return {
        public: handles.some((handle) => handle.public === true),
        auth: handles.some((handle) => handle.auth === true),
      };
    },
    navigate: (to, options) => void router.navigate(to, { replace: options?.replace }),
    currentPath: () => {
      const { pathname, search, hash } = router.state.location;
      return pathname + search + hash;
    },
  });
}

export function createAppRouter(): AppRouter {
  const router = createBrowserRouter(buildRoutes());
  connectRouter(router);
  return router;
}
