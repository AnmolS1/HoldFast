// Section 3: the runtime settings (`settings` table → SettingsDto). Each change is audited and
// takes effect within the 60 s settings cache. The terms bump asks for a NEW value and confirms
// with the number of accounts that will be asked again.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { AdminSettingsResponse, PatchSettingsBody } from "../../../../shared/schemas/admin";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { adminKeys, fetchSettings, patchSettings } from "../api";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Field, Loading, Note, Section, StatusLine } from "../ui";
import { refusalText } from "../words";

export function SettingsPage() {
  const query = useAdminQuery(adminKeys.settings, fetchSettings);
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <SettingsForm data={query.data} />;
}

const SWITCHES = ["uploadsEnabled", "linksEnabled", "readOnly", "orphanDeleteEnabled"] as const;

function SettingsForm({ data }: { data: AdminSettingsResponse }) {
  const client = useQueryClient();
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [terms, setTerms] = useState("");
  const [confirmTerms, setConfirmTerms] = useState(false);
  const [ceilings, setCeilings] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(data.settings.ceilings).map(([key, value]) => [key, String(value)])),
  );
  const settings = data.settings;

  const save = async (body: PatchSettingsBody) => {
    try {
      client.setQueryData(adminKeys.settings, await patchSettings(body));
      setStatus({ tone: "ok", text: t("settings.saved") });
    } catch (failure) {
      setStatus({ tone: "error", text: refusalText(failure) });
    }
  };

  const saveCeilings = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(ceilings)) {
      if (value.trim() !== "") next[key] = Number(value);
    }
    void save({ ceilings: next });
  };

  const keys = Object.keys(data.ceilingDefaults).sort();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-settings>
      <Section id="switches" title={t("settings.switches")}>
        <Box sx={{ width: 220 }}>
          <Field
            select
            label={t("settings.signupMode")}
            value={settings.signupMode}
            onChange={(event) => void save({ signupMode: event.target.value as "invite" | "open" })}
          >
            <MenuItem value="invite">{t("settings.invite")}</MenuItem>
            <MenuItem value="open">{t("settings.open")}</MenuItem>
          </Field>
        </Box>
        {SWITCHES.map((name) => (
          <Box key={name}>
            <FormControlLabel
              control={
                <Switch
                  checked={settings[name]}
                  onChange={(event) => void save({ [name]: event.target.checked })}
                />
              }
              label={t(`settings.${name}`)}
            />
            {name === "orphanDeleteEnabled" ? <Note>{t("settings.orphanWarning")}</Note> : null}
          </Box>
        ))}
      </Section>
      <Section id="terms" title={t("settings.terms")}>
        <Note>{t("settings.termsCurrent", { version: settings.termsVersion })}</Note>
        <Box
          component="form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (terms.trim() && terms.trim() !== settings.termsVersion) setConfirmTerms(true);
          }}
          sx={{ display: "flex", gap: 2, alignItems: "center" }}
        >
          <Box sx={{ width: 220 }}>
            <Field
              label={t("settings.termsNew")}
              name="termsVersion"
              value={terms}
              error={terms.trim() === settings.termsVersion ? t("settings.termsSame") : null}
              onChange={(event) => setTerms(event.target.value)}
            />
          </Box>
          <Button type="submit" disabled={!terms.trim() || terms.trim() === settings.termsVersion}>
            {t("settings.termsBump")}
          </Button>
        </Box>
      </Section>
      <Section id="ceilings" title={t("settings.ceilings")}>
        <Box
          component="form"
          onSubmit={saveCeilings}
          sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 2 }}
        >
          {keys.map((key) => (
            <Field
              key={key}
              label={key}
              name={key}
              value={ceilings[key] ?? ""}
              help={t("settings.ceilingHelp", {
                default: String(data.ceilingDefaults[key]),
                effective: String(
                  settings.ceilings[key as keyof typeof settings.ceilings] ?? data.ceilingDefaults[key],
                ),
              })}
              onChange={(event) => setCeilings((current) => ({ ...current, [key]: event.target.value }))}
            />
          ))}
          <Box>
            <Button type="submit">{t("common.save")}</Button>
          </Box>
        </Box>
      </Section>
      {status ? <StatusLine tone={status.tone}>{status.text}</StatusLine> : null}
      <ConfirmDialog
        open={confirmTerms}
        title={t("settings.termsConfirmTitle", { version: terms.trim() })}
        consequence={t("settings.termsConfirmBody", { count: data.termsAccounts })}
        confirmLabel={t("settings.termsBump")}
        onConfirm={() => {
          setConfirmTerms(false);
          void save({ termsVersion: terms.trim() });
          setTerms("");
        }}
        onCancel={() => setConfirmTerms(false)}
      />
    </Box>
  );
}
