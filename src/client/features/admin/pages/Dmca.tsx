// Section 7: copyright notices (§512). Intake with the §512(c)(3) elements, a completeness
// checklist and the nodes named (a notice naming several uploaders' files is split, one notice
// per alleged infringer); the takedown, the counter-notice and its window (10 and 14 BUSINESS
// days — US federal holidays are not modelled), restore, uphold, withdraw, close; a printable copy.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import type { DmcaActionBody, DmcaNoticeDto } from "../../../../shared/schemas/admin";
import {
  adminKeys,
  counterNotice,
  createNotice,
  fetchNotice,
  fetchNotices,
  noticeAction,
  noticeExportHref,
  queryString,
} from "../api";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Facts, Field, Loading, Mono, Note, ReasonDialog, Section, StatusLine } from "../ui";
import { eastern, label, refusalText, when } from "../words";

const CHECKLIST = [
  "identification",
  "work",
  "material",
  "contact",
  "goodFaith",
  "accuracy",
  "signature",
] as const;

export function DmcaPage() {
  const [status, setStatus] = useState("");
  const search = queryString({ status });
  const query = useAdminQuery(adminKeys.dmca(search), (signal) => fetchNotices(search, signal));
  const navigate = useNavigate();
  const columns: GridColDef[] = [
    { field: "receivedAt", headerName: t("dmca.received"), flex: 1 },
    { field: "complainant", headerName: t("dmca.complainant"), flex: 2 },
    { field: "status", headerName: t("dmca.status"), flex: 1 },
    { field: "nodes", headerName: t("dmca.nodes"), width: 90 },
  ];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Section
        id="dmca"
        title={t("nav.dmca")}
        action={<Button onClick={() => void query.refetch()}>{t("common.refresh")}</Button>}
      >
        <Box sx={{ width: 220 }}>
          <Field
            select
            label={t("dmca.status")}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <MenuItem value="">{t("common.any")}</MenuItem>
            {[
              "received",
              "incomplete",
              "rejected",
              "actioned",
              "counter_received",
              "restored",
              "upheld",
              "withdrawn",
              "closed",
            ].map((value) => (
              <MenuItem key={value} value={value}>
                {label("dmcaStatus", value)}
              </MenuItem>
            ))}
          </Field>
        </Box>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <AdminDataGrid
            rows={query.data.items.map((notice) => ({
              id: notice.id,
              receivedAt: when(notice.receivedAt),
              complainant: notice.complainantName ?? notice.complainantOrg ?? "—",
              status: label("dmcaStatus", notice.status),
              nodes: notice.nodes.length,
            }))}
            columns={columns}
            onRowClick={(params) => void navigate(`/admin/dmca/${String(params.id)}`)}
          />
        )}
      </Section>
      <Intake />
    </Box>
  );
}

function Intake() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    receivedVia: "email",
    complainantName: "",
    complainantOrg: "",
    complainantAddress: "",
    complainantPhone: "",
    complainantEmail: "",
    workDescription: "",
    infringingDescription: "",
    signature: "",
    rawText: "",
    nodeIds: "",
  });
  const [statements, setStatements] = useState({ statementGoodFaith: false, statementAccuracy: false });
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const set = (name: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [name]: event.target.value }));
  const optional = (value: string) => (value.trim() ? value.trim() : undefined);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const made = await createNotice({
        receivedVia: form.receivedVia as "email" | "form" | "post",
        complainantName: optional(form.complainantName),
        complainantOrg: optional(form.complainantOrg),
        complainantAddress: optional(form.complainantAddress),
        complainantPhone: optional(form.complainantPhone),
        complainantEmail: optional(form.complainantEmail),
        workDescription: optional(form.workDescription),
        infringingDescription: optional(form.infringingDescription),
        signature: optional(form.signature),
        rawText: optional(form.rawText),
        ...statements,
        nodeIds: form.nodeIds
          .split(/[\s,]+/)
          .map((id) => id.trim())
          .filter(Boolean),
      });
      void client.invalidateQueries({ queryKey: ["admin", "dmca"] });
      setStatus({ tone: "ok", text: t("dmca.created", { count: made.notices.length }) });
      if (made.notices.length === 1) void navigate(`/admin/dmca/${made.notices[0]!.id}`);
    } catch (failure) {
      setStatus({ tone: "error", text: refusalText(failure) });
    }
  };
  const fields = [
    "complainantName",
    "complainantOrg",
    "complainantAddress",
    "complainantPhone",
    "complainantEmail",
    "workDescription",
    "infringingDescription",
    "signature",
    "rawText",
    "nodeIds",
  ] as const;
  return (
    <Section id="intake" title={t("dmca.intake")}>
      <Box component="form" onSubmit={submit} sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box sx={{ width: 200 }}>
          <Field select label={t("dmca.via")} value={form.receivedVia} onChange={set("receivedVia")}>
            {["email", "form", "post"].map((value) => (
              <MenuItem key={value} value={value}>
                {label("via", value)}
              </MenuItem>
            ))}
          </Field>
        </Box>
        {fields.map((name) => (
          <Field
            key={name}
            label={t(`dmca.field.${name}`)}
            name={name}
            value={form[name]}
            multiline={name === "rawText" || name.endsWith("Description")}
            onChange={set(name)}
          />
        ))}
        {(["statementGoodFaith", "statementAccuracy"] as const).map((name) => (
          <FormControlLabel
            key={name}
            control={
              <Checkbox
                checked={statements[name]}
                onChange={(event) =>
                  setStatements((current) => ({ ...current, [name]: event.target.checked }))
                }
              />
            }
            label={t(`dmca.field.${name}`)}
          />
        ))}
        <Box>
          <Button type="submit" variant="contained">
            {t("dmca.create")}
          </Button>
        </Box>
        {status ? <StatusLine tone={status.tone}>{status.text}</StatusLine> : null}
      </Box>
    </Section>
  );
}

export function DmcaDetailPage() {
  const { noticeId = "" } = useParams();
  const query = useAdminQuery(adminKeys.notice(noticeId), (signal) => fetchNotice(noticeId, signal));
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <NoticeDetail notice={query.data} />;
}

type Action = DmcaActionBody["action"];
const ACTIONS: Record<string, Action[]> = {
  received: ["mark_incomplete", "reject", "takedown"],
  incomplete: ["reject", "takedown"],
  // `forward_counter` only once a counter-notice is in (the server refuses it before: m6).
  actioned: ["lawsuit_notice", "close", "withdraw"],
  counter_received: ["forward_counter", "lawsuit_notice", "restore", "uphold", "withdraw"],
};

function NoticeDetail({ notice }: { notice: DmcaNoticeDto }) {
  const client = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CHECKLIST.map((item) => [item, notice.checklist?.[item] === true])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counter, setCounter] = useState({
    counterName: "",
    counterAddress: "",
    counterPhone: "",
    counterEmail: "",
    counterStatement: "",
    counterSignature: "",
  });
  const [consent, setConsent] = useState(false);
  const [counterStatus, setCounterStatus] = useState<string | null>(null);
  const [lateAck, setLateAck] = useState(false);
  // Past the end of the 14th business day after receipt: no forward; a restore needs the
  // operator's explicit acknowledgement (the server refuses it otherwise: window_closed).
  // The clock is read once, when the detail opens (a render must not read it).
  const [openedAt] = useState(() => Date.now());
  const windowClosed = notice.restoreNotAfter !== null && openedAt > Date.parse(notice.restoreNotAfter);
  const lateRestore = action === "restore" && windowClosed;

  const update = (next: DmcaNoticeDto) => client.setQueryData(adminKeys.notice(notice.id), next);
  const act = async (note: string) => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      update(
        await noticeAction(notice.id, {
          action,
          note,
          checklist,
          ...(lateRestore ? { acknowledgeLate: lateAck } : {}),
        }),
      );
      setAction(null);
    } catch (failure) {
      setError(
        refusalText(failure, {
          before_window: t("dmca.beforeWindow"),
          window_closed: t("dmca.windowClosed"),
          forward_window_closed: t("dmca.forwardClosed"),
          not_forwarded: t("dmca.notForwarded"),
          already_forwarded: t("dmca.alreadyForwarded"),
          lawsuit: t("dmca.lawsuitBlocks"),
          state: t("dmca.wrongState"),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  const sendCounter = async (event: FormEvent) => {
    event.preventDefault();
    try {
      update(
        await counterNotice(notice.id, {
          ...counter,
          counterPhone: counter.counterPhone.trim() || undefined,
          counterConsentJurisdiction: consent,
        }),
      );
      setCounterStatus(t("dmca.counterSaved"));
    } catch (failure) {
      setCounterStatus(refusalText(failure));
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-notice={notice.id}>
      <Section
        id="notice"
        title={t("dmca.notice")}
        action={
          <Button component="a" href={noticeExportHref(notice.id)} target="_blank" rel="noopener">
            {t("dmca.print")}
          </Button>
        }
      >
        <Facts
          rows={[
            [t("dmca.id"), <Mono key="id">{notice.id}</Mono>],
            [t("dmca.status"), label("dmcaStatus", notice.status)],
            [t("dmca.received"), when(notice.receivedAt)],
            [
              t("dmca.complainant"),
              [notice.complainantName, notice.complainantOrg, notice.complainantEmail]
                .filter(Boolean)
                .join(" · ") || "—",
            ],
            [t("dmca.field.workDescription"), notice.workDescription ?? "—"],
            [t("dmca.field.infringingDescription"), notice.infringingDescription ?? "—"],
            [
              t("dmca.statements"),
              `${notice.statementGoodFaith ? t("common.yes") : t("common.no")} / ${notice.statementAccuracy ? t("common.yes") : t("common.no")}`,
            ],
            // Each with its id (R2 mod-7): Quarantine → "Find an item" takes it, and shows owner and uploader.
            [
              t("dmca.nodes"),
              notice.nodes
                .map((node) => (node.nodeName ? `${node.nodeName} (${node.nodeId})` : node.nodeId))
                .join(", ") || "—",
            ],
            [t("dmca.takedownAt"), when(notice.takedownAt)],
            [t("dmca.notified"), when(notice.ownerNotifiedAt)],
            // Day 0 of the window is the receipt's New York date: shown on that calendar (safety-n1).
            [
              t("dmca.counterReceived"),
              notice.counterReceivedAt
                ? t("dmca.easternAt", { at: eastern(notice.counterReceivedAt, "dateTime") })
                : "—",
            ],
            [t("dmca.counterForwarded"), when(notice.counterForwardedAt)],
            [
              t("dmca.window"),
              notice.restoreNotBefore
                ? t("dmca.windowValue", {
                    from: t("dmca.windowFrom", { at: eastern(notice.restoreNotBefore, "dateTime") }),
                    to: t("dmca.windowTo", { date: eastern(notice.restoreNotAfter, "long") }),
                  })
                : "—",
            ],
            [t("dmca.lawsuit"), when(notice.lawsuitNoticeAt)],
            [t("dmca.restored"), when(notice.restoredAt)],
          ]}
        />
        <Note>{t("dmca.holidays")}</Note>
        {notice.status === "counter_received" && windowClosed && !notice.counterForwardedAt ? (
          <Note>{t("dmca.forwardClosed")}</Note>
        ) : null}
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          {(ACTIONS[notice.status] ?? [])
            // Forwarded once, and never after the window (the server refuses both).
            .filter((name) => !(name === "forward_counter" && (notice.counterForwardedAt || windowClosed)))
            .map((name) => (
              <Button
                key={name}
                onClick={() => {
                  setLateAck(false);
                  setAction(name);
                }}
                color={name === "takedown" ? "error" : "primary"}
              >
                {label("dmcaAction", name)}
              </Button>
            ))}
        </Box>
      </Section>
      <Section id="checklist" title={t("dmca.checklist")}>
        {CHECKLIST.map((item) => (
          <FormControlLabel
            key={item}
            control={
              <Checkbox
                checked={checklist[item] ?? false}
                onChange={(event) =>
                  setChecklist((current) => ({ ...current, [item]: event.target.checked }))
                }
              />
            }
            label={t(`dmca.check.${item}`)}
          />
        ))}
      </Section>
      {notice.status === "actioned" || notice.status === "counter_received" ? (
        <Section id="counter" title={t("dmca.counter")}>
          <Box
            component="form"
            onSubmit={sendCounter}
            sx={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            {(Object.keys(counter) as Array<keyof typeof counter>).map((name) => (
              <Field
                key={name}
                label={t(`dmca.field.${name}`)}
                name={name}
                value={counter[name]}
                multiline={name === "counterStatement"}
                onChange={(event) => setCounter((current) => ({ ...current, [name]: event.target.value }))}
              />
            ))}
            <FormControlLabel
              control={<Checkbox checked={consent} onChange={(event) => setConsent(event.target.checked)} />}
              label={t("dmca.field.counterConsentJurisdiction")}
            />
            <Box>
              <Button type="submit">{t("dmca.saveCounter")}</Button>
            </Box>
            <StatusLine tone="ok">{counterStatus}</StatusLine>
          </Box>
        </Section>
      ) : null}
      <ReasonDialog
        open={action !== null}
        title={action ? label("dmcaAction", action) : ""}
        body={
          action === "takedown"
            ? t("dmca.takedownBody")
            : action === "restore"
              ? lateRestore
                ? t("dmca.restoreLateBody")
                : t("dmca.restoreBody")
              : undefined
        }
        canSubmit={!lateRestore || lateAck}
        confirmLabel={action ? label("dmcaAction", action) : ""}
        reasonLabel={t("dmca.note")}
        destructive={action === "takedown"}
        busy={busy}
        error={error}
        onSubmit={(note) => void act(note)}
        onCancel={() => setAction(null)}
      >
        {lateRestore ? (
          <FormControlLabel
            control={<Checkbox checked={lateAck} onChange={(event) => setLateAck(event.target.checked)} />}
            label={t("dmca.lateAck")}
          />
        ) : null}
      </ReasonDialog>
      <Box>
        <Button component={RouterLink} to="/admin/dmca">
          {t("common.back")}
        </Button>
      </Box>
    </Box>
  );
}
