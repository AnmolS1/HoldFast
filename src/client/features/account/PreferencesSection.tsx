// Preferences: appearance (theme, density, default view — lib/prefs.ts, synced to the server by
// ./prefs-sync.ts) and notifications (`emailShares`; security mail is always on). `emailLinkDigest`
// has no control in v1: the digest itself is v1.1.
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Switch from "@mui/material/Switch";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../../lib/api";
import { usePrefs, type Density, type ThemePref, type ViewMode } from "../../lib/prefs";
import { accountEpoch, sameAccount } from "../../lib/query";
import { hf } from "../../theme/tokens";
import { patchPrefs, prefsQuery } from "./api";
import { SectionError } from "./ProfileSection";
import { t, type AccountMessage } from "./strings";
import { Note, Section, StatusLine } from "./ui";

function Choice<V extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: AccountMessage }>;
  onChange(value: V): void;
}) {
  const labelId = useId();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box id={labelId} sx={{ fontSize: 13, fontWeight: 600 }}>
        {label}
      </Box>
      <RadioGroup
        row
        name={name}
        aria-labelledby={labelId}
        value={value}
        onChange={(event) => onChange(event.target.value as V)}
        data-pref={name}
      >
        {options.map((option) => (
          <FormControlLabel
            key={option.value}
            value={option.value}
            control={<Radio size="small" />}
            label={t(option.label)}
          />
        ))}
      </RadioGroup>
    </Box>
  );
}

const THEMES = [
  { value: "system", label: "prefs.theme.system" },
  { value: "light", label: "prefs.theme.light" },
  { value: "dark", label: "prefs.theme.dark" },
] as const satisfies ReadonlyArray<{ value: ThemePref; label: AccountMessage }>;
const DENSITIES = [
  { value: "compact", label: "prefs.density.compact" },
  { value: "comfortable", label: "prefs.density.comfortable" },
] as const satisfies ReadonlyArray<{ value: Density; label: AccountMessage }>;
const VIEWS = [
  { value: "list", label: "prefs.view.list" },
  { value: "grid", label: "prefs.view.grid" },
] as const satisfies ReadonlyArray<{ value: ViewMode; label: AccountMessage }>;

function Appearance() {
  const prefs = usePrefs();
  return (
    <Section id="appearance" title={t("prefs.appearance")}>
      <Choice
        label={t("prefs.theme")}
        name="theme"
        value={prefs.theme}
        options={THEMES}
        onChange={prefs.setTheme}
      />
      <Choice
        label={t("prefs.density")}
        name="density"
        value={prefs.density}
        options={DENSITIES}
        onChange={prefs.setDensity}
      />
      <Choice
        label={t("prefs.view")}
        name="viewMode"
        value={prefs.viewMode}
        options={VIEWS}
        onChange={prefs.setViewMode}
      />
    </Section>
  );
}

function Notifications() {
  const queryClient = useQueryClient();
  const prefs = useQuery(prefsQuery);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (prefs.isError) return <SectionError onRetry={() => void prefs.refetch()} />;
  const onShares = async (emailShares: boolean) => {
    const then = accountEpoch();
    setBusy(true);
    setError(null);
    try {
      const next = await patchPrefs({ emailShares });
      if (sameAccount(then)) queryClient.setQueryData(prefsQuery.queryKey, next);
    } catch (cause) {
      if (sameAccount(then)) setError(cause instanceof ApiError ? cause.message : t("account.failed"));
    } finally {
      if (sameAccount(then)) setBusy(false);
    }
  };
  return (
    <Section id="notifications" title={t("prefs.notifications")}>
      <FormControlLabel
        control={
          <Switch
            checked={prefs.data?.emailShares ?? false}
            disabled={!prefs.data || busy}
            onChange={(event) => void onShares(event.target.checked)}
            slotProps={{ input: { "aria-describedby": undefined } }}
          />
        }
        label={t("prefs.emailShares")}
        data-pref="emailShares"
      />
      <StatusLine tone="error">{error}</StatusLine>
      <Box
        data-pref="emailSecurity"
        sx={{ display: "flex", flexDirection: "column", gap: 1, paddingLeft: 1 }}
      >
        <Box sx={{ fontWeight: 600, fontSize: 13, color: hf.text }}>{t("prefs.emailSecurity")}</Box>
        <Note>{t("prefs.emailSecurity.fixed")}</Note>
      </Box>
    </Section>
  );
}

export function PreferencesSection() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <Appearance />
      <Notifications />
    </Box>
  );
}
