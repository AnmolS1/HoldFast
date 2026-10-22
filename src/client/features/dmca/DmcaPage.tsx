// The public DMCA page (`/dmca`, T29 §B.2): the designated agent's details as registered (agent.ts),
// the elements of a notice (§512(c)(3)), the counter-notice and its 10–14 business-day window
// (§512(g)), and the repeat-infringer policy from T10's constants. Signed out, outside the frame;
// it reads nothing from the API. The owner's "content removed" mail links here for the counter-notice.
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../../shared/constants";
import { LegalFooter } from "../../components/LegalFooter";
import { Wordmark } from "../../components/Mark";
import { hf, layout } from "../../theme/tokens";
import { AGENT } from "./agent";
import { t } from "./strings";

const NOTICE_ELEMENTS = [
  "dmca.notice.signature",
  "dmca.notice.work",
  "dmca.notice.material",
  "dmca.notice.contact",
  "dmca.notice.goodFaith",
  "dmca.notice.accuracy",
] as const;

const COUNTER_ELEMENTS = [
  "dmca.counter.signature",
  "dmca.counter.material",
  "dmca.counter.statement",
  "dmca.counter.identity",
] as const;

// Long unbroken values (an address, the sentinel) wrap instead of widening the page.
const wrap = { overflowWrap: "anywhere" } as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const headingId = `dmca-${id}`;
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ display: "grid", gap: 1.5 }}>
      <Typography id={headingId} variant="h2" sx={{ fontSize: 18, fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function List({ items }: { items: readonly string[] }) {
  return (
    <Box component="ol" sx={{ margin: 0, paddingLeft: 3, display: "grid", gap: 1 }}>
      {items.map((item) => (
        <Box component="li" key={item}>
          {item}
        </Box>
      ))}
    </Box>
  );
}

export function DmcaPage() {
  const rows: Array<[string, ReactNode]> = [
    [t("dmca.agent.name"), AGENT.name],
    [
      t("dmca.agent.address"),
      <Box component="span" sx={{ whiteSpace: "pre-line" }}>
        {AGENT.address}
      </Box>,
    ],
    [t("dmca.agent.phone"), AGENT.phone],
    [
      t("dmca.agent.email"),
      <Box component="a" href={`mailto:${AGENT.email}`} sx={{ color: hf.text, textDecoration: "underline" }}>
        {AGENT.email}
      </Box>,
    ],
  ];
  return (
    <Box
      data-dmca-page
      sx={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: hf.bg,
        color: hf.text,
      }}
    >
      <Box component="header" sx={{ display: "flex", alignItems: "center", px: 2, height: layout.header }}>
        <Wordmark />
      </Box>
      <Box
        component="main"
        sx={{
          flex: "1 1 auto",
          px: 2,
          py: 3,
          width: "100%",
          maxWidth: 720,
          mx: "auto",
          display: "grid",
          gap: 4,
        }}
      >
        <Box sx={{ display: "grid", gap: 1.5 }}>
          <Typography variant="h1" sx={{ fontSize: 28, fontWeight: 600 }}>
            {t("dmca.title")}
          </Typography>
          <Typography>{t("dmca.intro")}</Typography>
        </Box>

        <Section id="agent" title={t("dmca.agent.title")}>
          <Typography>{t("dmca.agent.lead")}</Typography>
          <Box
            component="dl"
            data-dmca-agent
            sx={{
              margin: 0,
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "8px 16px",
              ...wrap,
            }}
          >
            {rows.map(([label, value]) => (
              <Box key={label} sx={{ display: "contents" }}>
                <Box component="dt" sx={{ color: hf.textSecondary }}>
                  {label}
                </Box>
                <Box component="dd" sx={{ margin: 0, minWidth: 0 }}>
                  {value}
                </Box>
              </Box>
            ))}
          </Box>
        </Section>

        <Section id="notice" title={t("dmca.notice.title")}>
          <Typography>{t("dmca.notice.lead")}</Typography>
          <List items={NOTICE_ELEMENTS.map((key) => t(key))} />
          <Typography>{t("dmca.notice.after")}</Typography>
        </Section>

        <Section id="counter" title={t("dmca.counter.title")}>
          <Typography>{t("dmca.counter.lead")}</Typography>
          <List items={COUNTER_ELEMENTS.map((key) => t(key))} />
          <Typography>{t("dmca.counter.after")}</Typography>
        </Section>

        <Section id="repeat" title={t("dmca.repeat.title")}>
          <Typography>
            {t("dmca.repeat.body", { strikes: STRIKES_TO_SUSPEND, days: STRIKE_WINDOW_DAYS })}
          </Typography>
        </Section>

        <Section id="false" title={t("dmca.false.title")}>
          <Typography>{t("dmca.false.body")}</Typography>
        </Section>
      </Box>
      <Box component="footer" sx={{ display: "grid", justifyItems: "center", py: 2 }}>
        <LegalFooter />
      </Box>
    </Box>
  );
}
