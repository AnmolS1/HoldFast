// The typed slot stubs exist at their fixed paths with exactly the contract's props, and behave
// as the placeholder table says. The assignments below are checked by `tsc` (npm run typecheck).
import { render } from "@testing-library/react";
import { createAuthClient } from "better-auth/react";
import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import type * as Slots from "../../../../src/client/components/slots";
import type { FileListItem, MimeCategory, ScanStatus } from "../../../../src/client/components/types";
import { featureRoutes, publicRoutes } from "../../../../src/client/features";
import { DangerousFileInterstitial } from "../../../../src/client/features/interstitial";
import { PreviewDialog } from "../../../../src/client/features/preview";
import { ReportDialog, ReportLink } from "../../../../src/client/features/report";
import { SearchSuggestions } from "../../../../src/client/features/search";
import { ShareDialog } from "../../../../src/client/features/share";
import { requestUpload, UploadDropOverlay } from "../../../../src/client/features/upload";
import * as uploadSlots from "../../../../src/client/features/upload/slots";
import { useUsageSummary } from "../../../../src/client/features/usage";
import { authClient } from "../../../../src/client/lib/auth-client";
import type { AuthClientContract } from "../../../../src/client/lib/auth-contract";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact = <A, B>(proof: Exact<A, B> extends true ? true : never) => void proof;
type PropsOf<C> = C extends (props: infer P) => unknown ? P : never;

// Props are EXACTLY the contract's — neither wider nor narrower.
exact<PropsOf<typeof ReportLink>, Slots.ReportLinkProps>(true);
exact<PropsOf<typeof ReportDialog>, Slots.ReportDialogProps>(true);
exact<PropsOf<typeof DangerousFileInterstitial>, Slots.DangerousFileInterstitialProps>(true);
exact<PropsOf<typeof PreviewDialog>, Slots.PreviewDialogProps>(true);
exact<PropsOf<typeof ShareDialog>, Slots.ShareDialogProps>(true);
exact<PropsOf<typeof SearchSuggestions>, Slots.SearchSuggestionsProps>(true);
exact<ReturnType<typeof useUsageSummary>, Slots.UsageSummary | null>(true);
exact<typeof requestUpload, Slots.RequestUpload>(true);
exact<Parameters<typeof UploadDropOverlay>, []>(true);

// The shapes written in the task's tables.
exact<Slots.ReportTarget, { nodeId: string; linkToken?: string }>(true);
exact<Slots.DangerousFileInterstitialProps, { fileName: string; onContinue(): void; onCancel(): void }>(true);
exact<Slots.ShareDialogProps, { open: boolean; nodeId: string | null; onClose(): void }>(true);
exact<Slots.SearchSuggestionsProps, { query: string; onPick(nodeId: string): void }>(true);
exact<Slots.UsageSummary, { usedBytes: number; quotaBytes: number }>(true);
exact<
  Slots.PreviewItem,
  {
    id: string;
    name: string;
    size: number;
    mimeCategory: MimeCategory;
    ext: string;
    mimeSniffed?: string | null;
  }
>(true);
exact<Slots.PreviewDialogProps["source"], "owner" | Slots.PublicPreviewSource>(true);
exact<Parameters<Slots.RequestUpload>, [opts?: { files?: File[]; parentId?: string }]>(true);
exact<ScanStatus, "pending" | "clean" | "infected" | "suspected_csam" | "under_review" | "skipped" | "error">(
  true,
);

// A node DTO shaped like the contracts task's is assignable to the list item without an import.
const dto = {
  id: "n",
  kind: "file" as const,
  name: "a.pdf",
  size: 1,
  mimeCategory: "pdf" as const,
  scanStatus: "clean" as const,
  scanReason: null,
  updatedAt: "2026-10-02T00:00:00Z",
  parentId: null,
  etag: "e",
  starred: false,
};
const asItem: FileListItem = dto;
void asItem;

// Consumers can use each stub as a component of the contract's props.
const consumers: Array<ComponentType<never>> = [
  ReportLink,
  ReportDialog,
  DangerousFileInterstitial,
  PreviewDialog,
  ShareDialog,
  SearchSuggestions,
  UploadDropOverlay,
];

// The real Better Auth React client (with the three plugins the auth task installs) satisfies the
// shell's contract. If this line stops compiling after an upgrade, the contract is the thing to fix.
const realClient = () => createAuthClient({ plugins: [passkeyClient(), twoFactorClient(), adminClient()] });
const asContract = (): AuthClientContract => realClient();
void asContract;

describe("slot stubs", () => {
  it("render nothing", () => {
    const target = { nodeId: "n1", linkToken: "tok" };
    const { container } = render(
      <>
        <ReportLink target={target} />
        <ReportDialog open onClose={() => {}} target={target} />
        <PreviewDialog open nodeId="n1" onClose={() => {}} source="owner" />
        <ShareDialog open nodeId="n1" onClose={() => {}} />
        <SearchSuggestions query="tax" onPick={() => {}} />
        <UploadDropOverlay />
      </>,
    );
    expect(container.innerHTML).toBe("");
    expect(consumers.length).toBe(7);
  });

  it("the interstitial stub passes straight through: onContinue once, on mount", () => {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <DangerousFileInterstitial fileName="setup.exe" onContinue={onContinue} onCancel={onCancel} />,
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
    view.rerender(
      <DangerousFileInterstitial fileName="setup.exe" onContinue={onContinue} onCancel={onCancel} />,
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toBe("");
  });

  it("requestUpload is a no-op and useUsageSummary is null", () => {
    expect(requestUpload()).toBeUndefined();
    expect(requestUpload({ files: [], parentId: "p" })).toBeUndefined();
    expect(useUsageSummary()).toBeNull();
  });

  it("the frame's upload slots come from features/upload/slots.tsx and index.ts re-exports the same objects", () => {
    expect(uploadSlots.requestUpload).toBe(requestUpload);
    expect(uploadSlots.UploadDropOverlay).toBe(UploadDropOverlay);
  });
});

describe("the auth client", () => {
  it("is a plain object with every method of the contract (so a test can spy on one)", () => {
    const methods: Array<[string, unknown]> = [
      ["signIn.email", authClient.signIn.email],
      ["signIn.social", authClient.signIn.social],
      ["signIn.passkey", authClient.signIn.passkey],
      ["signUp.email", authClient.signUp.email],
      ["signOut", authClient.signOut],
      ["sendVerificationEmail", authClient.sendVerificationEmail],
      ["requestPasswordReset", authClient.requestPasswordReset],
      ["resetPassword", authClient.resetPassword],
      ["twoFactor.verifyTotp", authClient.twoFactor.verifyTotp],
      ["twoFactor.verifyBackupCode", authClient.twoFactor.verifyBackupCode],
      ["admin.stopImpersonating", authClient.admin.stopImpersonating],
    ];
    for (const [name, method] of methods) expect(typeof method, name).toBe("function");
    // Not the library's proxy: the same function on every access.
    expect(authClient.signIn.email).toBe(authClient.signIn.email);
    const contract: AuthClientContract = authClient;
    expect(Object.keys(contract).sort()).toEqual(
      [
        "admin",
        "requestPasswordReset",
        "resetPassword",
        "sendVerificationEmail",
        "signIn",
        "signOut",
        "signUp",
        "twoFactor",
      ].sort(),
    );
  });
});

describe("the route registry", () => {
  const paths = (routes: typeof featureRoutes) =>
    routes.map((route) => (route.index ? "(index)" : route.path)).sort();

  it("every destination has a real route — none is an empty array that would fall to not-found", () => {
    expect(paths(featureRoutes)).toEqual(
      [
        "(index)",
        "account/*",
        "admin/*",
        "folder/:id",
        "preview/:nodeId",
        "recent",
        "search",
        "shared",
        "shared-by-me",
        "starred",
        "storage",
        "trash",
        "uploads",
      ].sort(),
    );
  });

  it("public routes are split out by handle.public", () => {
    expect(paths(publicRoutes)).toEqual(["dmca", "s/:token"]);
    for (const route of publicRoutes) expect((route.handle as Slots.RouteHandle).public).toBe(true);
    for (const route of featureRoutes)
      expect((route.handle as Slots.RouteHandle | undefined)?.public).not.toBe(true);
  });

  it("the preview is an overlay route", () => {
    const preview = featureRoutes.find((route) => route.path === "preview/:nodeId");
    expect((preview?.handle as Slots.RouteHandle).overlay).toBe(true);
  });
});
