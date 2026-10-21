// `/s/:token` — the public link page. No account, minimal chrome, `noindex`; rendered outside the
// app frame and every auth guard (`handle.public`). It reads no session of the browser's.
//
//   a file     its card (name, size, the scan-clean line), Download, Preview (when the owner
//              allows it) through T18's PreviewDialog with a public source;
//   a folder   browse inside the link, Download or Preview per file, Download all as zip;
//   locked     the password form — at first, and again whenever the owner changes the password
//              while the page is open (the preview closes, a zip stops, the form shows ONCE);
//   refused    one sentence per state, never more: gone, at its limit, unavailable, high traffic.
//
// A dangerous type shows T22's `DangerousFileInterstitial` before a download is minted; the mint
// then carries `dangerousAck` (the API refuses one without it). The footer carries T22's
// `ReportLink` with the link token, and T08's `LegalFooter`.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useParams } from "react-router";
import type { PublicLinkInfo, PublicNodeDto } from "../../../shared/schemas/link";
import { NodeDetailDto } from "../../../shared/schemas/node";
import { Bytes } from "../../components/Bytes";
import { FileBadge, FolderGlyph } from "../../components/FileBadge";
import { LegalFooter } from "../../components/LegalFooter";
import { Wordmark } from "../../components/Mark";
import { api, ApiError } from "../../lib/api";
import { getCachedSession, holdUntil, useWaitUntil } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { DangerousFileInterstitial } from "../interstitial";
import { PreviewDialog } from "../preview";
import { ReportLink } from "../report";
import { isPasswordRequired, isWrongPassword, LinkClient, refusalOf } from "./client";
import { t } from "./strings";
import { zipFolder, type ZipRun } from "./zip";

const REFUSAL_WORDS = {
  gone: "public.state.gone",
  limit: "public.state.limit",
  traffic: "public.state.traffic",
  unavailable: "public.state.unavailable",
  error: "public.state.error",
} as const;

/** A notice under the actions after a download could not start. */
function mintProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "ceiling_exceeded") return t("public.file.tomorrow");
    if (error.code === "rate_limited") return t("public.file.busy");
    if (error.status === 410 && error.details?.reason === "limit_reached") return t("public.file.limit");
  }
  return t("public.file.failed");
}

/**
 * Start a download in a tab of its own (the files host answers it as an attachment; a refusal
 * shows there). Only an http(s) URL is ever opened; it is used once and kept nowhere.
 */
function startDownload(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  const link = document.createElement("a");
  link.href = parsed.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * While the page is shown: `noindex` (the app host also sends `X-Robots-Tag` for /s/*), and
 * `no-referrer` — the token is in this page's address, and nothing it loads or opens is sent it.
 */
function useNoIndex(): void {
  useEffect(() => {
    const tags = [
      ["robots", "noindex, nofollow"],
      ["referrer", "no-referrer"],
    ].map(([name, content]) => {
      const meta = document.createElement("meta");
      meta.name = name!;
      meta.content = content!;
      meta.setAttribute("data-public-link-noindex", "");
      document.head.appendChild(meta);
      return meta;
    });
    return () => tags.forEach((meta) => meta.remove());
  }, []);
}

// ── the password form ───────────────────────────────────────────────────────────────────────

function PasswordForm({ client, onUnlocked }: { client: LinkClient; onUnlocked(): void }) {
  const inputId = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  // Waits the API named live in the shell's registry, under this link.
  const waitHash = `public-link:unlock:${client.token}`;
  const until = useWaitUntil(waitHash);
  // The registry holds the wait; this clock only draws it (and the form again once it is over).
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (until === 0) return;
    const tick = () => setClock(Date.now());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 1000);
    const end = setTimeout(tick, Math.max(0, until - Date.now()) + 50);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      clearTimeout(end);
    };
  }, [until]);
  const waiting = until > 0 && until > clock;
  const seconds = Math.max(1, Math.ceil((until - clock) / 1000));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || waiting) return;
    setBusy(true);
    setWrong(false);
    try {
      await client.unlock(password);
      setPassword("");
      onUnlocked();
    } catch (error) {
      if (error instanceof ApiError && error.code === "rate_limited") {
        holdUntil(waitHash, Date.now() + (error.retryAfter ?? 60) * 1000);
      } else if (isWrongPassword(error)) {
        setWrong(true);
        const after = Number((error as ApiError).details?.retryAfterSec ?? 0);
        if (after > 0) holdUntil(waitHash, Date.now() + after * 1000);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box
      component="form"
      onSubmit={submit}
      data-public-password
      sx={{ display: "grid", gap: 2, maxWidth: 360 }}
    >
      <Typography component="h1" variant="h5">
        {t("public.password.title")}
      </Typography>
      <Typography sx={{ color: hf.textSecondary }}>{t("public.password.body")}</Typography>
      <TextField
        id={inputId}
        type="password"
        label={t("public.password.label")}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="off"
        autoFocus
        error={wrong}
      />
      {wrong ? (
        <Typography role="alert" sx={{ color: hf.danger }}>
          {t("public.password.wrong")}
        </Typography>
      ) : null}
      {waiting && clock > 0 ? (
        <Typography role="status" data-public-wait>
          {seconds < 60
            ? t("public.password.wait", { seconds })
            : t("public.password.waitMinutes", { minutes: Math.ceil(seconds / 60) })}
        </Typography>
      ) : null}
      <Box>
        <Button type="submit" variant="contained" disabled={busy || waiting || password === ""}>
          {busy ? t("public.password.checking") : t("public.password.submit")}
        </Button>
      </Box>
    </Box>
  );
}

// ── downloads with the warning first ────────────────────────────────────────────────────────

type Pending = { name: string; resolve(go: boolean): void };

/** Asks T22's interstitial before a dangerous download; resolves whether to go on. */
function useDangerGate() {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (name: string) =>
      new Promise<boolean>((resolve) => {
        setPending({ name, resolve });
      }),
    [],
  );
  const element = pending ? (
    <DangerousFileInterstitial
      fileName={pending.name}
      onContinue={() => {
        pending.resolve(true);
        setPending(null);
      }}
      onCancel={() => {
        pending.resolve(false);
        setPending(null);
      }}
    />
  ) : null;
  return { ask, element };
}

function useDownload(client: LinkClient, askDanger: (name: string) => Promise<boolean>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const download = async (node: PublicNodeDto, knownDangerous = false) => {
    setBusy(node.id);
    setProblem(null);
    try {
      // A type known to be dangerous is confirmed BEFORE anything is minted.
      let ack = false;
      if (knownDangerous) {
        if (!(await askDanger(node.name))) return;
        ack = true;
      }
      for (;;) {
        try {
          const minted = await client.mint(node.id, "download", { dangerousAck: ack });
          startDownload(minted.url);
          return;
        } catch (error) {
          const dangerous =
            error instanceof ApiError &&
            error.code === "forbidden" &&
            error.details?.reason === "dangerous_ack";
          if (dangerous && !ack) {
            if (!(await askDanger(node.name))) return;
            ack = true;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (!isPasswordRequired(error)) setProblem(mintProblem(error));
    } finally {
      setBusy(null);
    }
  };
  return { busy, problem, download };
}

// ── the folder ──────────────────────────────────────────────────────────────────────────────

type Crumb = { id: string | null; name: string };

function FolderView({
  client,
  root,
  allowPreview,
  onPreview,
  askDanger,
}: {
  client: LinkClient;
  root: PublicNodeDto;
  allowPreview: boolean;
  onPreview(id: string, siblings: string[]): void;
  askDanger(name: string): Promise<boolean>;
}) {
  const [trail, setTrail] = useState<Crumb[]>([{ id: null, name: root.name }]);
  const here = trail[trail.length - 1]!;
  const listing = useInfiniteQuery({
    queryKey: ["public-link", client.token, "children", here.id],
    queryFn: ({ pageParam }) => client.children(here.id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const items = useMemo(() => listing.data?.pages.flatMap((page) => page.items) ?? [], [listing.data]);
  const loading = listing.isPending || listing.isFetchingNextPage;
  const failed = listing.isError && !isPasswordRequired(listing.error);
  const { busy, problem, download } = useDownload(client, askDanger);
  const [zip, setZip] = useState<{ done: number; total: number; controller: AbortController } | null>(null);
  const [zipNotice, setZipNotice] = useState<string | null>(null);
  // The zip stops with the page — on unmount only (a progress update is a new state object, and
  // must not end the zip it reports on).
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const files = items.filter((item) => item.kind === "file");
  const runZip = async () => {
    const controller = new AbortController();
    running.current = controller;
    setZipNotice(null);
    setZip({ done: 0, total: 0, controller });
    const run: ZipRun = await zipFolder(client, root.name, {
      signal: controller.signal,
      progress: (done, total) => setZip((current) => (current ? { ...current, done, total } : current)),
      confirmDangerous: askDanger,
      save: saveBlob,
    });
    setZip(null);
    running.current = null;
    const unavailable =
      run.unavailable === 0
        ? ""
        : ` ${run.unavailable === 1 ? t("public.zip.unavailable.one") : t("public.zip.unavailable", { count: run.unavailable })}`;
    const words: Record<ZipRun["outcome"], string | null> = {
      saved: t("public.zip.saved") + unavailable,
      partial: t("public.zip.partial", { count: run.missing.length }) + unavailable,
      empty: t("public.zip.empty"),
      too_large: t("public.zip.tooLarge"),
      cancelled: t("public.zip.cancelled"),
      failed: run.error ? mintProblem(run.error) : t("public.zip.failed"),
      locked: null,
    };
    setZipNotice(words[run.outcome]);
  };

  return (
    <Box data-public-folder sx={{ display: "grid", gap: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <FolderGlyph />
        <Typography component="h1" variant="h5" sx={{ overflowWrap: "anywhere" }}>
          {here.name}
        </Typography>
        <Box sx={{ flex: "1 1 auto" }} />
        {zip ? (
          <>
            <Typography role="status">
              {t("public.zip.working", { done: zip.done, total: zip.total })}
            </Typography>
            <Button onClick={() => zip.controller.abort()}>{t("public.zip.cancel")}</Button>
          </>
        ) : (
          <Button variant="contained" onClick={() => void runZip()} data-public-zip>
            {t("public.zip.download")}
          </Button>
        )}
      </Box>
      {trail.length > 1 ? (
        <Box>
          <Button onClick={() => setTrail((current) => current.slice(0, -1))}>
            {t("public.folder.up", { name: trail[trail.length - 2]!.name })}
          </Button>
        </Box>
      ) : null}
      {zipNotice ? <Typography role="status">{zipNotice}</Typography> : null}
      {problem ? (
        <Typography role="alert" sx={{ color: hf.danger }}>
          {problem}
        </Typography>
      ) : null}
      {failed ? <Typography role="alert">{t("public.state.error")}</Typography> : null}
      {!loading && items.length === 0 && !failed ? (
        <Typography sx={{ color: hf.textSecondary }}>{t("public.folder.empty")}</Typography>
      ) : null}
      <Box
        component="ul"
        aria-label={t("public.folder.list", { name: here.name })}
        sx={{ listStyle: "none", p: 0, m: 0 }}
      >
        {items.map((item) => (
          <Box
            component="li"
            key={item.id}
            data-public-item={item.id}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              minHeight: layout.rowHeight,
              borderBottom: `1px solid ${hf.hairline}`,
            }}
          >
            {item.kind === "folder" ? (
              <FolderGlyph />
            ) : (
              <FileBadge name={item.name} mimeCategory={item.mimeCategory} />
            )}
            {item.kind === "folder" ? (
              <Button
                onClick={() => setTrail((current) => [...current, { id: item.id, name: item.name }])}
                aria-label={t("public.folder.open", { name: item.name })}
                sx={{ justifyContent: "flex-start", textTransform: "none", flex: "1 1 auto" }}
              >
                {item.name}
              </Button>
            ) : (
              <>
                <Typography sx={{ flex: "1 1 auto", overflowWrap: "anywhere" }}>{item.name}</Typography>
                <Typography sx={{ color: hf.textSecondary }}>
                  <Bytes value={item.size} />
                </Typography>
                {allowPreview ? (
                  <Button
                    size="small"
                    aria-label={t("public.folder.previewFile", { name: item.name })}
                    onClick={() =>
                      onPreview(
                        item.id,
                        files.map((file) => file.id),
                      )
                    }
                  >
                    {t("public.file.preview")}
                  </Button>
                ) : null}
                <Button
                  size="small"
                  aria-label={t("public.folder.downloadFile", { name: item.name })}
                  disabled={busy === item.id}
                  onClick={() => void download(item)}
                >
                  {t("public.file.download")}
                </Button>
              </>
            )}
          </Box>
        ))}
      </Box>
      {listing.hasNextPage ? (
        <Box>
          <Button onClick={() => void listing.fetchNextPage()} disabled={loading}>
            {t("public.folder.more")}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}

// ── the file ────────────────────────────────────────────────────────────────────────────────

function FileCard({
  client,
  info,
  node,
  onPreview,
  askDanger,
}: {
  client: LinkClient;
  info: PublicLinkInfo;
  node: PublicNodeDto;
  onPreview(id: string): void;
  askDanger(name: string): Promise<boolean>;
}) {
  const { busy, problem, download } = useDownload(client, askDanger);
  return (
    <Box data-public-file sx={{ display: "grid", gap: 2, maxWidth: 560 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <FileBadge name={node.name} mimeCategory={node.mimeCategory} size={28} />
        <Typography component="h1" variant="h5" sx={{ overflowWrap: "anywhere" }}>
          {node.name}
        </Typography>
      </Box>
      <Typography sx={{ color: hf.textSecondary }}>
        <Bytes value={node.size} />
      </Typography>
      <Typography data-public-clean sx={{ color: hf.textSecondary }}>
        {t("public.file.clean")}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Button
          variant="contained"
          onClick={() => void download(node, info.dangerous)}
          disabled={busy !== null}
          data-public-download
        >
          {busy ? t("public.file.downloading") : t("public.file.download")}
        </Button>
        {info.allowPreview ? (
          <Button onClick={() => onPreview(node.id)} data-public-preview>
            {t("public.file.preview")}
          </Button>
        ) : null}
      </Box>
      {problem ? (
        <Typography role="alert" data-public-problem sx={{ color: hf.danger }}>
          {problem}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * "Open in Holdfast" for the link's owner. The page reads no session of its own: only when this tab
 * already holds one in memory is the node asked for — once, quietly — and the button shown when
 * the answer says the caller owns it.
 */
function OpenInApp({ nodeId }: { nodeId: string }) {
  const known = getCachedSession() ?? null;
  const owner = useQuery({
    queryKey: ["public-link", "owner", nodeId],
    queryFn: ({ signal }) =>
      api(`/api/nodes/${encodeURIComponent(nodeId)}`, {
        schema: NodeDetailDto,
        signal,
        silent: ["not_found", "unauthorized", "forbidden", "rate_limited"],
      }),
    enabled: known !== null,
    retry: false,
  });
  if (owner.data?.node.role !== "owner") return null;
  const href = owner.data.node.kind === "folder" ? `/folder/${nodeId}` : `/preview/${nodeId}`;
  return (
    <Button href={href} variant="outlined" data-public-open-in-app>
      {t("public.openInApp")}
    </Button>
  );
}

// ── the page ────────────────────────────────────────────────────────────────────────────────

export function PublicLinkPage() {
  const { token = "" } = useParams();
  useNoIndex();
  const client = useMemo(() => new LinkClient(token), [token]);
  const locked = useSyncExternalStore(client.subscribe, client.isLocked, client.isLocked);
  const [preview, setPreview] = useState<{ id: string; siblings: string[] } | null>(null);
  const danger = useDangerGate();
  const source = useMemo(() => client.source(), [client]);
  const infoQuery = useQuery({
    queryKey: ["public-link", token, "info"],
    queryFn: () => client.info(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const info = infoQuery.data ?? null;
  const refusal =
    infoQuery.isError && !isPasswordRequired(infoQuery.error) ? refusalOf(infoQuery.error) : null;
  const load = () => void infoQuery.refetch();

  // Locked again (a new password while the page is open): the preview closes, the form shows.
  useEffect(
    () =>
      client.subscribe(() => {
        if (client.isLocked()) setPreview(null);
      }),
    [client],
  );

  const node = info?.node ?? null;
  let body;
  if (refusal) {
    body = (
      <Box data-public-state={refusal} role="alert" sx={{ display: "grid", gap: 2 }}>
        <Typography component="h1" variant="h5">
          {t(REFUSAL_WORDS[refusal])}
        </Typography>
        {refusal === "error" ? (
          <Box>
            <Button onClick={load}>{t("public.retry")}</Button>
          </Box>
        ) : null}
      </Box>
    );
  } else if (locked) {
    body = <PasswordForm client={client} onUnlocked={load} />;
  } else if (!info || !node) {
    body = (
      <Typography role="status" sx={{ color: hf.textSecondary }}>
        {t("public.loading")}
      </Typography>
    );
  } else if (node.kind === "folder") {
    body = (
      <FolderView
        client={client}
        root={node}
        allowPreview={info.allowPreview}
        onPreview={(id, siblings) => setPreview({ id, siblings })}
        askDanger={danger.ask}
      />
    );
  } else {
    body = (
      <FileCard
        client={client}
        info={info}
        node={node}
        onPreview={(id) => setPreview({ id, siblings: [id] })}
        askDanger={danger.ask}
      />
    );
  }

  return (
    <Box
      data-public-link-page
      sx={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: hf.bg,
        color: hf.text,
      }}
    >
      <Box
        component="header"
        sx={{ display: "flex", alignItems: "center", gap: 2, px: 2, height: layout.header }}
      >
        <Wordmark />
        <Box sx={{ flex: "1 1 auto" }} />
        {node && !locked ? <OpenInApp nodeId={node.id} /> : null}
      </Box>
      <Box component="main" sx={{ flex: "1 1 auto", px: 2, py: 3, width: "100%", maxWidth: 880, mx: "auto" }}>
        {body}
      </Box>
      <Box component="footer" sx={{ display: "grid", justifyItems: "center", gap: 1, py: 2 }}>
        {/* A report is about a FILE: a folder link's files are reported from their preview. */}
        {node && !locked && node.kind === "file" ? (
          <ReportLink target={{ nodeId: node.id, linkToken: token }} />
        ) : null}
        <LegalFooter />
      </Box>
      {danger.element}
      {info && !locked ? (
        <PreviewDialog
          open={preview !== null}
          nodeId={preview?.id ?? null}
          siblingIds={preview?.siblings}
          onNavigate={(id) => setPreview((current) => (current ? { ...current, id } : current))}
          onClose={() => setPreview(null)}
          source={source}
        />
      ) : null}
    </Box>
  );
}
