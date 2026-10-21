// The share dialog (T08's `ShareDialog` slot): people, links, and who has access.
//
//   people   email → role → Share; each row shows the address, its role, the upload toggle
//            (editors) and Remove. A share to an address with no account looks exactly like any
//            other: the API says nothing about the address, and neither does this dialog.
//   links    Create link (expiry, password, download limit, preview) → Copy link, at any time
//            later too (the API re-derives the URL for its owner on every read). The settings
//            read as a sentence whose segments each open their own editor. Pause / Resume (only
//            where the API says the owner may), Revoke (irreversible: confirmed, the blast radius
//            stated), and a sparkline of the last 30 days.
//
// ACCOUNT CHANGE. While open the dialog registers a purger: a sign-out or another account in
// another tab closes it and drops every draft. A change still in flight when that happens is
// dropped too (`forThisAccount`): its answer never reaches the next account's dialog or cache.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { LinkDto, PatchLinkBody } from "../../../shared/schemas/link";
import { NodeDetailDto } from "../../../shared/schemas/node";
import type { ShareDto, ShareRole } from "../../../shared/schemas/share";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { RelativeTime } from "../../components/RelativeTime";
import type { ShareDialogProps } from "../../components/slots";
import { toast } from "../../components/Toaster";
import { api, ApiError, toastApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { usePublicConfig } from "../../lib/query";
import { hf } from "../../theme/tokens";
import {
  createLink,
  createShare,
  forThisAccount,
  patchLink,
  patchShare,
  refreshSharing,
  removeShare,
  revokeLink,
  useLinkActivity,
  useNodeSharing,
} from "./api";
import {
  copyText,
  countWords,
  expiryOf,
  linkSentence,
  pauseAction,
  pausedLines,
  stateWords,
  type ExpiryChoice,
  type LinkSetting,
} from "./link-words";
import { t } from "./strings";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

const detail = (error: unknown, key: string): unknown =>
  error instanceof ApiError ? error.details?.[key] : undefined;

/** The words for a refused share. */
function shareRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const reason = detail(error, "reason");
  if (error.code === "validation")
    return reason === "self_share" ? t("share.people.self") : t("share.people.invalid");
  if (error.code === "conflict")
    return reason === "grantee_limit" ? t("share.people.limit") : t("share.people.duplicate");
  if (error.code === "ceiling_exceeded") return t("share.people.ceiling");
  return null;
}

function linkRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "feature_disabled") return t("share.links.disabled");
  if (error.code === "ceiling_exceeded") return t("share.links.ceiling");
  if (error.code === "validation") return t("share.links.failed");
  return null;
}

// ── who has access ──────────────────────────────────────────────────────────────────────────

function AccessSummary({ shares, links }: { shares: ShareDto[]; links: LinkDto[] }) {
  const people = shares.length;
  const linked = links.some((link) => link.state === "active");
  const peopleWords =
    people === 0
      ? null
      : people === 1
        ? t("share.access.people.one")
        : t("share.access.people", { count: people });
  const words =
    peopleWords && linked
      ? t("share.access.and", { first: peopleWords, second: t("share.access.link") })
      : (peopleWords ?? (linked ? t("share.access.link") : t("share.access.onlyYou")));
  return (
    <Box data-share-access sx={{ mb: 2 }}>
      <Typography variant="subtitle2" component="h3">
        {t("share.access.title")}
      </Typography>
      <Typography sx={{ color: hf.textSecondary }}>{words}</Typography>
    </Box>
  );
}

// ── people ──────────────────────────────────────────────────────────────────────────────────

function AddPerson({ nodeId, onDone }: { nodeId: string; onDone(): void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await forThisAccount(() => createShare(nodeId, { email: address, role }));
      if (result.dropped) return;
      setEmail("");
      toast({ message: t("share.people.added", { email: address }) });
      onDone();
    } catch (error) {
      const words = shareRefusal(error);
      if (words) setProblem(words);
      else toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box component="form" onSubmit={submit} data-share-add sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
      <TextField
        label={t("share.people.email")}
        type="email"
        size="small"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
        autoComplete="off"
        sx={{ flex: "1 1 220px" }}
        error={problem !== null}
        slotProps={{ htmlInput: { "aria-describedby": problem ? problemId : undefined } }}
      />
      <TextField
        select
        size="small"
        label={t("share.people.role")}
        value={role}
        onChange={(event) => setRole(event.target.value as ShareRole)}
        sx={{ minWidth: 140 }}
      >
        <MenuItem value="viewer">{t("share.role.viewer")}</MenuItem>
        <MenuItem value="editor">{t("share.role.editor")}</MenuItem>
      </TextField>
      <Button type="submit" variant="contained" disabled={busy || email.trim() === ""}>
        {busy ? t("share.people.adding") : t("share.people.add")}
      </Button>
      {problem ? (
        <Typography id={problemId} role="alert" sx={{ color: hf.danger, flexBasis: "100%" }}>
          {problem}
        </Typography>
      ) : null}
    </Box>
  );
}

function PersonRow({ share }: { share: ShareDto }) {
  const [busy, setBusy] = useState(false);
  const change = async (body: Parameters<typeof patchShare>[1]) => {
    setBusy(true);
    try {
      const result = await forThisAccount(() => patchShare(share.id, body));
      if (!result.dropped) refreshSharing();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const result = await forThisAccount(() => removeShare(share.id));
      if (result.dropped) return;
      toast({ message: t("share.people.removed", { email: share.email }) });
      refreshSharing();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box
      component="li"
      data-share-person={share.id}
      sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5, flexWrap: "wrap" }}
    >
      <Typography sx={{ flex: "1 1 180px", overflowWrap: "anywhere" }}>{share.email}</Typography>
      <TextField
        select
        size="small"
        value={share.role}
        disabled={busy}
        onChange={(event) => void change({ role: event.target.value as ShareRole })}
        slotProps={{ htmlInput: { "aria-label": `${t("share.people.role")}: ${share.email}` } }}
      >
        <MenuItem value="viewer">{t("share.role.viewer")}</MenuItem>
        <MenuItem value="editor">{t("share.role.editor")}</MenuItem>
      </TextField>
      {share.role === "editor" ? (
        <FormControlLabel
          control={
            <Switch
              checked={share.canUpload}
              disabled={busy}
              onChange={(event) => void change({ canUpload: event.target.checked })}
            />
          }
          label={t("share.people.canUpload")}
        />
      ) : null}
      <IconButton
        aria-label={t("share.people.remove", { email: share.email })}
        disabled={busy}
        onClick={() => void remove()}
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

// ── links ───────────────────────────────────────────────────────────────────────────────────

/** Downloads per day over the last 30 days, as a line of bars. */
function Sparkline({ linkId }: { linkId: string }) {
  const activity = useLinkActivity(linkId);
  const days = activity.data?.days ?? [];
  const total = days.reduce((sum, day) => sum + day.downloads, 0);
  const max = Math.max(1, ...days.map((day) => day.downloads));
  const label =
    total === 0
      ? t("share.links.activity.none")
      : `${t("share.links.activity")}: ${countWords({ downloadCount: total, maxDownloads: null })}`;
  return (
    <Box
      component="span"
      data-link-sparkline
      role="img"
      aria-label={label}
      title={label}
      sx={{ display: "inline-flex" }}
    >
      <svg width={90} height={18} aria-hidden="true">
        {days.slice(-30).map((day, index) => {
          const height = Math.max(1, Math.round((day.downloads / max) * 16));
          return (
            <rect key={day.day} x={index * 3} y={18 - height} width={2} height={height} fill="currentColor" />
          );
        })}
      </svg>
    </Box>
  );
}

/** One setting's editor, opened from its segment of the sentence. */
function SettingEditor({
  link,
  setting,
  anchor,
  onClose,
}: {
  link: LinkDto;
  setting: LinkSetting;
  anchor: HTMLElement | null;
  onClose(): void;
}) {
  const [preview, setPreview] = useState(link.allowPreview);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("7d");
  const [customDate, setCustomDate] = useState("");
  const [limit, setLimit] = useState(link.maxDownloads === null ? "" : String(link.maxDownloads));
  const [busy, setBusy] = useState(false);
  const save = async (body: PatchLinkBody) => {
    setBusy(true);
    try {
      const result = await forThisAccount(() => patchLink(link.id, body));
      if (result.dropped) return;
      toast({ message: t("share.settings.saved") });
      refreshSharing();
      onClose();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (setting === "preview") void save({ allowPreview: preview });
    if (setting === "password" && password.length >= 8) void save({ password });
    if (setting === "expiry") {
      const expiresAt = expiryOf(expiry, customDate, Date.now());
      if (expiresAt !== undefined) void save({ expiresAt });
    }
    if (setting === "limit") void save({ maxDownloads: limit.trim() === "" ? null : Number(limit) });
  };
  return (
    <Popover
      open={anchor !== null}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
    >
      <Box
        component="form"
        onSubmit={onSubmit}
        data-link-editor={setting}
        sx={{ p: 2, display: "grid", gap: 1.5, minWidth: 260 }}
      >
        {setting === "preview" ? (
          <FormControlLabel
            control={<Checkbox checked={preview} onChange={(event) => setPreview(event.target.checked)} />}
            label={t("share.settings.preview")}
          />
        ) : null}
        {setting === "password" ? (
          <>
            <TextField
              type="password"
              size="small"
              label={t("share.settings.password")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              helperText={
                password.length > 0 && password.length < 8 ? t("share.settings.password.short") : undefined
              }
            />
            {link.hasPassword ? (
              <Button onClick={() => void save({ password: null })} disabled={busy}>
                {t("share.settings.password.remove")}
              </Button>
            ) : null}
          </>
        ) : null}
        {setting === "expiry" ? (
          <ExpiryFields
            choice={expiry}
            onChoice={setExpiry}
            date={customDate}
            onDate={setCustomDate}
            allowNever
          />
        ) : null}
        {setting === "limit" ? (
          <TextField
            type="number"
            size="small"
            label={t("share.settings.limit")}
            helperText={t("share.settings.limit.hint")}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            slotProps={{ htmlInput: { min: 1, step: 1 } }}
          />
        ) : null}
        <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end" }}>
          <Button onClick={onClose} disabled={busy}>
            {t("share.settings.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t("share.settings.save")}
          </Button>
        </Box>
      </Box>
    </Popover>
  );
}

function ExpiryFields({
  choice,
  onChoice,
  date,
  onDate,
  allowNever,
}: {
  choice: ExpiryChoice;
  onChoice(choice: ExpiryChoice): void;
  date: string;
  onDate(date: string): void;
  allowNever: boolean;
}) {
  return (
    <>
      <TextField
        select
        size="small"
        label={t("share.settings.expiry")}
        value={choice}
        onChange={(event) => onChoice(event.target.value as ExpiryChoice)}
      >
        {allowNever ? <MenuItem value="never">{t("share.settings.expiry.never")}</MenuItem> : null}
        <MenuItem value="1d">{t("share.settings.expiry.1d")}</MenuItem>
        <MenuItem value="7d">{t("share.settings.expiry.7d")}</MenuItem>
        <MenuItem value="30d">{t("share.settings.expiry.30d")}</MenuItem>
        <MenuItem value="custom">{t("share.settings.expiry.custom")}</MenuItem>
      </TextField>
      {choice === "custom" ? (
        <TextField
          type="date"
          size="small"
          label={t("share.settings.expiry.date")}
          value={date}
          onChange={(event) => onDate(event.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      ) : null}
    </>
  );
}

export function LinkRow({ link, now }: { link: LinkDto; now: number }) {
  const [editing, setEditing] = useState<{ setting: LinkSetting; anchor: HTMLElement } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = pauseAction(link);
  const live = link.state !== "revoked" && link.state !== "expired";

  const copy = async () => {
    if (!link.url) {
      toast({ message: t("share.links.noUrl") });
      return;
    }
    toast({ message: (await copyText(link.url)) ? t("share.links.copied") : t("share.links.copyFailed") });
  };
  const setPaused = async (paused: boolean) => {
    setBusy(true);
    try {
      const result = await forThisAccount(() => patchLink(link.id, { paused }));
      if (!result.dropped) refreshSharing();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    try {
      const result = await forThisAccount(() => revokeLink(link.id));
      if (result.dropped) return;
      setConfirming(false);
      toast({ message: t("share.links.revoked") });
      refreshSharing();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      component="li"
      data-share-link={link.id}
      data-link-state={link.state}
      sx={{ py: 1, borderTop: `1px solid ${hf.hairline}` }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography component="span" data-link-state-chip sx={{ fontWeight: 600 }}>
          {stateWords(link.state)}
        </Typography>
        <Sparkline linkId={link.id} />
        <Box sx={{ flex: "1 1 auto" }} />
        {live ? (
          <Button
            size="small"
            startIcon={<Copy size={14} aria-hidden="true" />}
            onClick={() => void copy()}
            disabled={!link.url}
          >
            {t("share.links.copy")}
          </Button>
        ) : null}
        {action ? (
          <Button size="small" onClick={() => void setPaused(action === "pause")} disabled={busy}>
            {t(action === "pause" ? "share.links.pause" : "share.links.resume")}
          </Button>
        ) : null}
        {link.state !== "revoked" ? (
          <Button size="small" color="error" onClick={() => setConfirming(true)} disabled={busy}>
            {t("share.links.revoke")}
          </Button>
        ) : null}
      </Box>
      <Typography component="p" data-link-sentence sx={{ mt: 0.5 }}>
        {t("link.sentence.anyone")}{" "}
        {linkSentence(link, now).map((segment, index) => (
          <span key={segment.setting}>
            {index > 0 ? " · " : null}
            {live && link.state !== "locked" ? (
              <Box
                component="button"
                type="button"
                data-link-segment={segment.setting}
                onClick={(event) => setEditing({ setting: segment.setting, anchor: event.currentTarget })}
                sx={{
                  font: "inherit",
                  fontWeight: 700,
                  color: "inherit",
                  background: "none",
                  border: 0,
                  p: 0,
                  cursor: "pointer",
                  textDecoration: "underline dotted",
                  textUnderlineOffset: "3px",
                }}
              >
                {segment.text}
              </Box>
            ) : (
              <b>{segment.text}</b>
            )}
          </span>
        ))}
      </Typography>
      {link.limitedToday ? (
        <Typography data-link-limited sx={{ color: hf.textSecondary }}>
          {t("link.limitedToday")}
        </Typography>
      ) : null}
      {pausedLines(link.pausedReasons).map((line) => (
        <Typography key={line} data-link-paused-reason sx={{ color: hf.textSecondary }}>
          {line}
        </Typography>
      ))}
      <Typography sx={{ color: hf.textSecondary }}>
        {countWords(link)}
        {" · "}
        {link.lastAccessAt ? (
          <>
            {t("link.lastAccess")} <RelativeTime value={link.lastAccessAt} />
          </>
        ) : (
          t("link.lastAccess.never")
        )}
      </Typography>
      {editing ? (
        <SettingEditor
          link={link}
          setting={editing.setting}
          anchor={editing.anchor}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t("share.links.revoke.title")}
        consequence={t("share.links.revoke.consequence")}
        confirmLabel={t("share.links.revoke")}
        destructive
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setConfirming(false)}
      />
    </Box>
  );
}

function CreateLink({ nodeId, onDone }: { nodeId: string; onDone(link: LinkDto): void }) {
  const config = usePublicConfig();
  const [expiry, setExpiry] = useState<ExpiryChoice>("7d");
  const [customDate, setCustomDate] = useState("");
  const [password, setPassword] = useState("");
  const [limit, setLimit] = useState("");
  const [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (config.data && !config.data.linksEnabled) {
    return <Typography sx={{ color: hf.textSecondary }}>{t("share.links.disabled")}</Typography>;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const expiresAt = expiryOf(expiry, customDate, Date.now());
    if (expiresAt === undefined || (password !== "" && password.length < 8)) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await forThisAccount(() =>
        createLink(nodeId, {
          allowPreview: preview,
          ...(expiresAt === null ? {} : { expiresAt }),
          ...(password === "" ? {} : { password }),
          ...(limit.trim() === "" ? {} : { maxDownloads: Number(limit) }),
        }),
      );
      if (result.dropped) return;
      setPassword("");
      onDone(result.value);
    } catch (error) {
      const words = linkRefusal(error);
      if (words) setProblem(words);
      else toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box component="form" onSubmit={submit} data-link-create sx={{ display: "grid", gap: 1.5, mt: 1 }}>
      <ExpiryFields
        choice={expiry}
        onChoice={setExpiry}
        date={customDate}
        onDate={setCustomDate}
        allowNever
      />
      <TextField
        type="password"
        size="small"
        label={t("share.settings.password")}
        helperText={
          password.length > 0 && password.length < 8
            ? t("share.settings.password.short")
            : t("share.settings.password.hint")
        }
        error={password.length > 0 && password.length < 8}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="new-password"
      />
      <TextField
        type="number"
        size="small"
        label={t("share.settings.limit")}
        helperText={t("share.settings.limit.hint")}
        value={limit}
        onChange={(event) => setLimit(event.target.value)}
        slotProps={{ htmlInput: { min: 1, step: 1 } }}
      />
      <FormControlLabel
        control={<Checkbox checked={preview} onChange={(event) => setPreview(event.target.checked)} />}
        label={t("share.settings.preview")}
      />
      <Box>
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? t("share.links.creating") : t("share.links.create")}
        </Button>
      </Box>
      {problem ? (
        <Typography role="alert" sx={{ color: hf.danger }}>
          {problem}
        </Typography>
      ) : null}
    </Box>
  );
}

// ── the dialog ──────────────────────────────────────────────────────────────────────────────

export function ShareDialog({ open, nodeId, onClose }: ShareDialogProps) {
  const titleId = useId();
  const sharing = useNodeSharing(open ? nodeId : null);
  const name = useQuery({
    queryKey: ["sharing", "node-name", nodeId ?? ""],
    queryFn: ({ signal }) =>
      api(`/api/nodes/${encodeURIComponent(nodeId!)}`, { schema: NodeDetailDto, signal }).then(
        (answer) => answer.node.name,
      ),
    enabled: open && nodeId !== null,
  });
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // The dialog belongs to the account it was opened for: a purge closes it.
  useEffect(() => {
    if (!open) return;
    return registerUserStatePurger(() => closeRef.current());
  }, [open]);

  const data = sharing.data;
  // "expires in 7 days" is said as of the moment the list was read.
  const now = sharing.dataUpdatedAt;
  return (
    <Dialog
      open={open && nodeId !== null}
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth="sm"
      fullWidth
      data-share-dialog
    >
      <DialogTitle id={titleId}>
        {name.data ? t("share.title", { name: name.data }) : t("share.title.loading")}
      </DialogTitle>
      <DialogContent>
        {sharing.isError ? (
          <Box role="alert" sx={{ display: "grid", gap: 1 }}>
            <Typography>{t("share.loadError")}</Typography>
            <Box>
              <Button onClick={() => void sharing.refetch()}>{t("share.retry")}</Button>
            </Box>
          </Box>
        ) : null}
        {data && nodeId ? (
          <>
            <AccessSummary shares={data.shares} links={data.links} />
            {data.inheritedFrom ? (
              <Typography data-share-inherited sx={{ color: hf.textSecondary, mb: 2 }}>
                {t("share.inherited", { name: data.inheritedFrom.name })}
              </Typography>
            ) : null}
            <Typography variant="subtitle2" component="h3">
              {t("share.people.title")}
            </Typography>
            <AddPerson nodeId={nodeId} onDone={refreshSharing} />
            {data.shares.length === 0 ? (
              <Typography sx={{ color: hf.textSecondary, mt: 1 }}>{t("share.people.none")}</Typography>
            ) : (
              <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, mt: 1 }}>
                {data.shares.map((share) => (
                  <PersonRow key={share.id} share={share} />
                ))}
              </Box>
            )}
            <Typography variant="subtitle2" component="h3" sx={{ mt: 3 }}>
              {t("share.links.title")}
            </Typography>
            {data.links.length === 0 ? (
              <Typography sx={{ color: hf.textSecondary }}>{t("share.links.none")}</Typography>
            ) : (
              <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
                {data.links.map((link) => (
                  <LinkRow key={link.id} link={link} now={now} />
                ))}
              </Box>
            )}
            <CreateLink
              nodeId={nodeId}
              onDone={(link) => {
                refreshSharing();
                if (link.url)
                  void copyText(link.url).then(
                    (copied) => copied && toast({ message: t("share.links.copied") }),
                  );
              }}
            />
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("share.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}
