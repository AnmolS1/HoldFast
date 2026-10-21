// Signed-in pages per ROLE, built on T06's sign-in fixtures (tests/setup/auth-fixtures.ts — wrapped,
// never edited):
//
//   test("…", async ({ roles }) => {
//     const owner = await roles.owner();     // the test's own `page`, signed in, with a fresh folder
//     const editor = await roles.editor();   // a second user in a context of their own, given an
//     const viewer = await roles.viewer();   //   editor / viewer share of the owner's folder
//     const admin = await roles.admin();     // role admin, two-factor passed, a context of its own
//   });
//
// Lazy: a role is made the first time it is asked for, once per test (editor and viewer make the
// owner first). Each role signs up from a client address of its own — the Worker allows 3 sign-ups
// a day per address — and each extra context sends that address on its browser requests, the way
// the `clientIp` fixture does for `page`. The extra pages get the same CPU throttle as `page`
// (HOLDFAST_E2E_CPU_THROTTLE) and the same limit on loads of the app document.
// Local runs only: they write (sign-ups, a folder, shares). A remote run asking for one fails.
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import {
  signedInAdmin2fa,
  signedInUser,
  type SignedInAdmin,
  type SignedInUser,
} from "../../setup/auth-fixtures";
import { appOrigin, e2ePort } from "../../setup/local-env";
import { addressFor } from "./address";
import { remoteMode } from "./remote";

export type ShareRole = "editor" | "viewer";

export interface RolePage {
  page: Page;
  user: SignedInUser;
  /** The client address this role's requests carry (pass it to `signedIn*` / API calls). */
  clientIp: string;
  /** Headers for this role's own `page.request` writes: the Origin a browser sends, and the address. */
  headers: Record<string, string>;
}

export interface OwnerPage extends RolePage {
  /** A folder of the owner's, at the top of their tree, made for this test; the shares are of it. */
  folderId: string;
  folderName: string;
}

export interface AdminPage extends RolePage {
  user: SignedInAdmin;
}

export interface Roles {
  owner(): Promise<OwnerPage>;
  editor(): Promise<RolePage>;
  viewer(): Promise<RolePage>;
  admin(): Promise<AdminPage>;
}

export interface RoleDeps {
  page: Page;
  browser: Browser;
  testInfo: TestInfo;
  /** MAX_APP_LOADS_PER_TEST: the same limit, for each extra page. */
  maxLoads: number;
}

const writeHeaders = (clientIp: string) => ({ origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp });

/** Every browser request of `context` to the app origin carries `clientIp` (as the `clientIp` fixture does). */
async function sendAddress(context: BrowserContext, clientIp: string): Promise<void> {
  await context.route(`${appOrigin(e2ePort())}/**`, (route) =>
    route.fallback({ headers: { ...route.request().headers(), "cf-connecting-ip": clientIp } }),
  );
}

async function expectStatus(
  response: Awaited<ReturnType<APIRequestContext["post"]>>,
  status: number,
  what: string,
): Promise<void> {
  if (response.status() !== status) {
    throw new Error(`role fixture: ${what} answered ${response.status()}, not ${status}`);
  }
}

/**
 * The roles of one test. `close()` ends the extra contexts and fails a passing test whose extra
 * page loaded the app more often than `maxLoads`.
 */
export function rolesFor(deps: RoleDeps): Roles & { close(): Promise<void> } {
  const { page, browser, testInfo, maxLoads } = deps;
  const extras: Array<{ context: BrowserContext; loads: string[]; role: string }> = [];
  const seed = `${testInfo.project.name}|${testInfo.testId}|${testInfo.retry}`;
  const made = new Map<string, Promise<unknown>>();
  const once = <T>(role: string, make: () => Promise<T>): Promise<T> => {
    if (remoteMode() !== null) {
      return Promise.reject(
        new Error(`role fixture: no "${role}" in a remote run (a role signs up and writes)`),
      );
    }
    let promise = made.get(role) as Promise<T> | undefined;
    if (!promise) {
      promise = make();
      made.set(role, promise);
    }
    return promise;
  };

  async function extraPage(role: string, clientIp: string): Promise<Page> {
    // The project's device (desktop or Pixel 7), as `page` has it.
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
    const context = await browser.newContext({
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      baseURL: appOrigin(e2ePort()),
    });
    const loads: string[] = [];
    extras.push({ context, loads, role });
    await sendAddress(context, clientIp);
    const extra = await context.newPage();
    const throttle = Number(process.env.HOLDFAST_E2E_CPU_THROTTLE ?? "");
    if (throttle > 1) {
      const cdp = await context.newCDPSession(extra);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    extra.on("response", (response) => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.frame() !== extra.mainFrame()) return;
      if (!(response.headers()["content-type"] ?? "").includes("text/html")) return;
      loads.push(new URL(response.url()).pathname);
    });
    return extra;
  }

  const owner = () =>
    once("owner", async (): Promise<OwnerPage> => {
      const clientIp = addressFor(`${seed}|owner`);
      await sendAddress(page.context(), clientIp);
      const user = await signedInUser(page, { clientIp });
      const folderName = `e2e roles ${user.id.slice(0, 8)}`;
      const created = await page.request.post("/api/nodes/folder", {
        headers: writeHeaders(clientIp),
        data: { parentId: null, name: folderName },
      });
      await expectStatus(created, 200, "creating the owner's folder");
      const folderId = ((await created.json()) as { id: string }).id;
      return { page, user, clientIp, headers: writeHeaders(clientIp), folderId, folderName };
    });

  const grantee = (role: ShareRole) =>
    once(role, async (): Promise<RolePage> => {
      const own = await owner();
      const clientIp = addressFor(`${seed}|${role}`);
      const extra = await extraPage(role, clientIp);
      const user = await signedInUser(extra, { clientIp });
      const shared = await own.page.request.post(`/api/nodes/${own.folderId}/shares`, {
        headers: own.headers,
        data: { email: user.email, role },
      });
      await expectStatus(shared, 201, `sharing the owner's folder as ${role}`);
      return { page: extra, user, clientIp, headers: writeHeaders(clientIp) };
    });

  const admin = () =>
    once("admin", async (): Promise<AdminPage> => {
      const clientIp = addressFor(`${seed}|admin`);
      const extra = await extraPage("admin", clientIp);
      const user = await signedInAdmin2fa(extra, { clientIp });
      return { page: extra, user, clientIp, headers: writeHeaders(clientIp) };
    });

  return {
    owner,
    editor: () => grantee("editor"),
    viewer: () => grantee("viewer"),
    admin,
    async close() {
      const over = extras.filter(({ loads }) => loads.length > maxLoads);
      await Promise.all(extras.map(({ context }) => context.close().catch(() => undefined)));
      if (over.length > 0 && testInfo.status === testInfo.expectedStatus) {
        throw new Error(
          over
            .map(
              ({ role, loads }) =>
                `${loads.length} loads of the app on the ${role}'s page: ${loads.join(", ")}`,
            )
            .join("; ") + ` (at most ${maxLoads} each; reach other pages with navigateInApp).`,
        );
      }
    },
  };
}
