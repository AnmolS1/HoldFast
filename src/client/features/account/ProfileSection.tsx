// Profile: picture, display name, email address, time zone, language.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ProfileDto } from "../../../shared/schemas/account";
import { ThumbImage } from "../../components/ThumbImage";
import { toast } from "../../components/Toaster";
import { ApiError } from "../../lib/api";
import { accountEpoch, refreshSession, sameAccount, useSession } from "../../lib/query";
import { hf } from "../../theme/tokens";
import { avatarUrl, linkedQuery, patchProfile, profileQuery } from "./api";
import { AUTH_CODES, changeEmail } from "./auth-calls";
import { uploadAvatar, type AvatarOutcome } from "./avatar";
import { useSignInAgain } from "./session";
import { t } from "./strings";
import { failureText } from "./failures";
import { LabeledField, Note, Section, StatusLine } from "./ui";

const AVATAR_TEXT: Record<Exclude<AvatarOutcome, "ok">, Parameters<typeof t>[0]> = {
  unchecked: "profile.avatar.unchecked",
  scanner_starting: "profile.avatar.scannerStarting",
  not_image: "profile.avatar.notImage",
  too_large: "profile.avatar.tooLarge",
  failed: "account.failed",
};

function initialsOf(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

function Initials({ profile }: { profile: ProfileDto }) {
  return (
    <Box
      data-avatar="initials"
      aria-hidden="true"
      sx={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 24,
        fontWeight: 600,
        color: hf.textSecondary,
      }}
    >
      {initialsOf(profile.displayName, profile.email)}
    </Box>
  );
}

function AvatarPart({ profile, userId }: { profile: ProfileDto; userId: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  /** Where the upload is: the bytes going up, then the server scanning them. */
  const [phase, setPhase] = useState<"idle" | "uploading" | "checking">("idle");
  const busy = phase !== "idle";
  const [problem, setProblem] = useState<string | null>(null);
  /** The picture to send again when the scanner was still starting (nothing of it was kept). */
  const [retry, setRetry] = useState<File | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const then = accountEpoch();
    setPhase("uploading");
    setProblem(null);
    setRetry(null);
    const outcome = await uploadAvatar(file, undefined, () => {
      if (sameAccount(then)) setPhase("checking");
    });
    // Another account by now: nothing of this upload is shown or cached for it.
    if (!sameAccount(then)) return;
    setPhase("idle");
    if (outcome === "ok") {
      toast({ message: t("profile.avatar.done"), key: "avatar" });
      await queryClient.invalidateQueries({ queryKey: profileQuery.queryKey });
      return;
    }
    // The initials stay: nothing became the avatar.
    setProblem(t(AVATAR_TEXT[outcome]));
    if (outcome === "scanner_starting") setRetry(file);
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      <Box
        data-avatar-box
        sx={{
          width: 72,
          height: 72,
          borderRadius: "50%",
          overflow: "hidden",
          flex: "none",
          backgroundColor: hf.surface2,
        }}
      >
        {profile.avatar ? (
          <ThumbImage
            nodeId={profile.avatar.nodeId}
            versionKey={profile.avatar.etag}
            size={160}
            alt={t("profile.avatar.alt")}
            eligible
            getUrl={() => avatarUrl(userId, 160)}
            fallback={<Initials profile={profile} />}
          />
        ) : (
          <Initials profile={profile} />
        )}
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 240px" }}>
        <Box>
          <Button variant="outlined" onClick={() => input.current?.click()} disabled={busy}>
            {phase === "checking"
              ? t("profile.avatar.checking")
              : phase === "uploading"
                ? t("profile.avatar.uploading")
                : t("profile.avatar.change")}
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            data-avatar-input
            aria-label={t("profile.avatar.change")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void onFile(file);
            }}
          />
        </Box>
        <Note>{t("profile.avatar.help")}</Note>
        <StatusLine tone="ok">{phase === "checking" ? t("profile.avatar.checkingHelp") : null}</StatusLine>
        <StatusLine tone="error">{problem}</StatusLine>
        {retry && !busy ? (
          <Box>
            <Button variant="outlined" data-avatar-retry onClick={() => void onFile(retry)}>
              {t("profile.avatar.tryAgain")}
            </Button>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function NameForm({ profile }: { profile: ProfileDto }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(profile.displayName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 80) {
      setError(t("profile.name.error"));
      return;
    }
    setError(null);
    setBusy(true);
    const then = accountEpoch();
    try {
      const next = await patchProfile({ displayName: trimmed });
      if (!sameAccount(then)) return;
      queryClient.setQueryData(profileQuery.queryKey, next);
      toast({ message: t("account.saved"), key: "profile" });
      void refreshSession().catch(() => {});
    } catch (cause) {
      if (sameAccount(then)) setError(cause instanceof ApiError ? cause.message : t("account.failed"));
    } finally {
      if (sameAccount(then)) setBusy(false);
    }
  };
  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      sx={{ display: "flex", gap: 2, alignItems: "flex-start", flexWrap: "wrap" }}
    >
      <Box sx={{ flex: "1 1 240px" }}>
        <LabeledField
          label={t("profile.name")}
          name="displayName"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={error}
          slotProps={{ htmlInput: { maxLength: 80 } }}
        />
      </Box>
      <Button
        type="submit"
        variant="outlined"
        disabled={busy || name.trim() === profile.displayName}
        sx={{ marginTop: "22px" }}
      >
        {busy ? t("account.saving") : t("account.save")}
      </Button>
    </Box>
  );
}

function EmailPart({ profile, hasPassword }: { profile: ProfileDto; hasPassword: boolean }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [notFresh, setNotFresh] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signInAgain = useSignInAgain();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = email.trim().toLowerCase();
    setEmailError(null);
    setPasswordError(null);
    setFailure(null);
    setNotFresh(false);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next) || next.length > 254) {
      setEmailError(t("profile.email.invalid"));
      return;
    }
    if (next === profile.email) {
      setEmailError(t("profile.email.same"));
      return;
    }
    if (hasPassword && password === "") {
      setPasswordError(t("account.passwordWrong"));
      return;
    }
    setBusy(true);
    const result = await changeEmail({ newEmail: next, ...(hasPassword ? { password } : {}) });
    setBusy(false);
    if (!result.error) {
      setSentTo(profile.email);
      setOpen(false);
      setEmail("");
      setPassword("");
      return;
    }
    if (result.error.code === AUTH_CODES.invalidPassword) setPasswordError(t("account.passwordWrong"));
    else if (result.error.code === AUTH_CODES.sessionNotFresh) setNotFresh(true);
    else setFailure(failureText(result.error));
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 3,
          flexWrap: "wrap",
        }}
      >
        <Box>
          <Box sx={{ fontSize: 12, color: hf.textSecondary }}>{t("profile.email")}</Box>
          <Box data-profile-email sx={{ overflowWrap: "anywhere" }}>
            {profile.email}
          </Box>
        </Box>
        {open ? null : (
          <Button variant="outlined" onClick={() => setOpen(true)}>
            {t("profile.email.change")}
          </Button>
        )}
      </Box>
      <StatusLine tone="ok">{sentTo ? t("profile.email.sent", { email: sentTo }) : null}</StatusLine>
      {open ? (
        <Box
          component="form"
          noValidate
          onSubmit={submit}
          data-email-form
          sx={{ display: "flex", flexDirection: "column", gap: 3 }}
        >
          <Note>{t("profile.email.help")}</Note>
          <LabeledField
            label={t("profile.email.new")}
            type="email"
            name="newEmail"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={emailError}
          />
          {hasPassword ? (
            <LabeledField
              label={t("account.passwordField")}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={passwordError}
            />
          ) : null}
          {notFresh ? (
            <StatusLine tone="error">
              <Box component="span" data-reauth-needed>
                {t("account.signInAgain")}{" "}
              </Box>
              <Button size="small" onClick={() => void signInAgain()}>
                {t("account.signInAgain.action")}
              </Button>
            </StatusLine>
          ) : null}
          <StatusLine tone="error">{failure}</StatusLine>
          <Box sx={{ display: "flex", gap: 2 }}>
            <Button type="submit" variant="contained" disabled={busy}>
              {t("profile.email.submit")}
            </Button>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              {t("account.cancel")}
            </Button>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function allZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function ZoneAndLanguage({ profile }: { profile: ProfileDto }) {
  const queryClient = useQueryClient();
  const zones = useMemo(() => allZones(), []);
  const device = useMemo(() => deviceZone(), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = profile.timezone ?? "";
  const options = useMemo(
    () => (current && !zones.includes(current) ? [current, ...zones] : zones),
    [current, zones],
  );

  const save = async (zone: string) => {
    setBusy(true);
    setError(null);
    const then = accountEpoch();
    try {
      const next = await patchProfile({ timezone: zone });
      if (!sameAccount(then)) return;
      queryClient.setQueryData(profileQuery.queryKey, next);
      // The shell's dates read the zone from the session: read it again so they follow now.
      await refreshSession().catch(() => null);
      toast({ message: t("account.saved"), key: "profile" });
    } catch (cause) {
      if (sameAccount(then)) setError(cause instanceof ApiError ? cause.message : t("account.failed"));
    } finally {
      if (sameAccount(then)) setBusy(false);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <LabeledField
        select
        label={t("profile.timezone")}
        name="timezone"
        value={current}
        disabled={busy}
        help={t("profile.timezone.help")}
        error={error}
        onChange={(event) => {
          const zone = event.target.value === "" ? device : event.target.value;
          if (zone !== current) void save(zone);
        }}
        slotProps={{ select: { native: true } }}
      >
        {current === "" ? <option value="">{t("profile.timezone.device", { zone: device })}</option> : null}
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll("_", " ")}
          </option>
        ))}
      </LabeledField>
      <LabeledField
        select
        label={t("profile.locale")}
        name="locale"
        value={profile.locale.toLowerCase().startsWith("en") ? profile.locale : "en"}
        help={t("profile.locale.help")}
        slotProps={{ select: { native: false } }}
      >
        <MenuItem value={profile.locale.toLowerCase().startsWith("en") ? profile.locale : "en"}>
          {t("profile.locale.en")}
        </MenuItem>
      </LabeledField>
    </Box>
  );
}

/** `?email=unavailable`: the confirmation of an address change arrived after the address was taken. */
function useEmailUnavailable(): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const [unavailable] = useState(() => new URLSearchParams(location.search).get("email") === "unavailable");
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("email") !== "unavailable") return;
    params.delete("email");
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate]);
  return unavailable;
}

export function ProfileSection() {
  const session = useSession().data;
  const profile = useQuery(profileQuery);
  const linked = useQuery(linkedQuery);
  const unavailable = useEmailUnavailable();
  const userId = session?.user.id ?? null;
  if (profile.isError) return <SectionError onRetry={() => void profile.refetch()} />;
  if (!profile.data || !userId) return <Box data-account-loading aria-busy="true" />;
  const hasPassword = linked.data?.some((row) => row.providerId === "credential") ?? true;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {unavailable ? (
        <StatusLine tone="error">
          <Box component="span" data-email-unavailable>
            {t("profile.email.unavailable")}
          </Box>
        </StatusLine>
      ) : null}
      <Section id="avatar" title={t("profile.avatar")}>
        <AvatarPart profile={profile.data} userId={userId} />
      </Section>
      <Section id="name" title={t("profile.name")}>
        <NameForm profile={profile.data} />
      </Section>
      <Section id="email" title={t("profile.email")}>
        <EmailPart profile={profile.data} hasPassword={hasPassword} />
      </Section>
      <Section id="zone" title={t("profile.timezone")}>
        <ZoneAndLanguage profile={profile.data} />
      </Section>
    </Box>
  );
}

export function SectionError({ onRetry }: { onRetry(): void }) {
  return (
    <Box
      role="alert"
      data-account-error
      sx={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}
    >
      <Box component="h2" sx={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
        {t("account.error.title")}
      </Box>
      <Note>{t("account.error.body")}</Note>
      <Button variant="outlined" onClick={onRetry}>
        {t("account.retry")}
      </Button>
    </Box>
  );
}
