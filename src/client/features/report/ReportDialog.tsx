// The report form (T08's `ReportLink` / `ReportDialog` slots; decision D6). A category, details,
// an address (public pages only — a signed-in reporter is known by the session), Turnstile, then
// ONE request per click: the public route with the link token, the signed-in route without it.
// On success the plain fact: the file is hidden while it is reviewed.
//
// A `429` names its wait: it is recorded in the shell's wait registry (`holdUntil`) and the send
// button stays off until it has passed — nothing is retried by itself.
//
// ACCOUNT CHANGE. While open the dialog registers a purger: a sign-out or another account closes
// it and drops the draft (category, details, address). An answer that arrives after such a purge
// (`sameAccount`) is dropped: no confirmation is shown to the next account.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Email } from "../../../shared/schemas/common";
import { ReportCategory } from "../../../shared/schemas/report";
import type { ReportDialogProps, ReportLinkProps } from "../../components/slots";
import { ApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import {
  accountEpoch,
  getCachedSession,
  holdUntil,
  retryNotBefore,
  sameAccount,
  usePublicConfig,
  useWaitUntil,
} from "../../lib/query";
import { useTurnstile, type UseTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { REPORT_WAIT_KEY, sendReport } from "./api";
import { t } from "./strings";

type Category = (typeof ReportCategory.options)[number];
const CATEGORIES = ReportCategory.options;
const DETAILS_MAX = 4000;

/** The words for a refused report, and whether the Turnstile token was spent. */
function refusal(error: unknown): string {
  if (!(error instanceof ApiError)) return t("report.failed");
  if (error.code === "not_found") return t("report.gone");
  if (error.code === "rate_limited") {
    if (error.retryAfter === undefined) return t("report.limit");
    const at = new Date(Date.now() + error.retryAfter * 1000);
    return t("report.limit.until", {
      time: at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    });
  }
  if (error.code === "forbidden" && error.details?.code === "VERIFICATION_FAILED")
    return t("report.human.failed");
  if (error.code === "feature_disabled") return t("report.human.unavailable");
  // The server's own words for a refusal of the target (a folder, the reporter's own file).
  if (error.code === "validation" && error.message) return error.message;
  return t("report.failed");
}

/** Whether a recorded wait has ended — re-rendered by a timer of its own when it does. */
function useWaitOver(until: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(timer);
  }, [until]);
  return until <= now;
}

/** Where the Turnstile widget renders. */
function HumanCheck({ turnstile }: { turnstile: UseTurnstile }) {
  const { attach, status } = turnstile;
  return <Box ref={attach} data-turnstile={status} />;
}

function ReportForm({ target, onClose }: { target: ReportDialogProps["target"]; onClose(): void }) {
  const { data: config } = usePublicConfig();
  const siteKey = config?.turnstileSiteKey || undefined;
  const turnstile = useTurnstile(siteKey);
  const publicRoute = target.linkToken !== undefined;
  const [category, setCategory] = useState<Category | null>(null);
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const waitEnds = useWaitUntil(REPORT_WAIT_KEY);
  const waitOver = useWaitOver(waitEnds);
  const groupId = useId();
  const statusId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (category === null) {
      setProblem(t("report.pick"));
      return;
    }
    const address = email.trim();
    if (publicRoute && address !== "" && !Email.safeParse(address).success) {
      setProblem(t("report.email.invalid"));
      return;
    }
    if (!siteKey) {
      setProblem(t("report.human.missing"));
      return;
    }
    if (!turnstile.token) {
      setProblem(t(turnstile.status === "error" ? "report.human.failed" : "report.human.wait"));
      return;
    }
    const then = accountEpoch();
    setBusy(true);
    setProblem(null);
    try {
      await sendReport(target, {
        category,
        details,
        turnstileToken: turnstile.token,
        ...(publicRoute && address !== "" ? { reporterEmail: address } : {}),
      });
      if (!sameAccount(then)) return;
      setDone(true);
    } catch (error) {
      if (!sameAccount(then)) return;
      const until = retryNotBefore(error, Date.now());
      if (until > 0) holdUntil(REPORT_WAIT_KEY, until);
      setProblem(refusal(error));
      // A token is single-use: the next try needs a new one.
      turnstile.reset();
    } finally {
      if (sameAccount(then)) setBusy(false);
    }
  };

  if (done) {
    return (
      <>
        <DialogContent>
          <Typography role="status" data-report-done>
            {t("report.done")}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={onClose}>
            {t("report.close")}
          </Button>
        </DialogActions>
      </>
    );
  }

  return (
    <Box component="form" noValidate onSubmit={submit} data-report-form>
      <DialogContent sx={{ display: "grid", gap: 2 }}>
        <Typography sx={{ color: hf.textSecondary }}>{t("report.intro")}</Typography>
        <FormControl>
          <FormLabel id={groupId}>{t("report.category")}</FormLabel>
          <RadioGroup
            aria-labelledby={groupId}
            name="category"
            value={category ?? ""}
            onChange={(event) => setCategory(event.target.value as Category)}
          >
            {CATEGORIES.map((value) => (
              <FormControlLabel
                key={value}
                value={value}
                control={<Radio />}
                label={t(`report.category.${value}`)}
              />
            ))}
          </RadioGroup>
        </FormControl>
        <TextField
          label={t("report.details")}
          helperText={t("report.details.help")}
          multiline
          minRows={3}
          value={details}
          onChange={(event) => setDetails(event.target.value.slice(0, DETAILS_MAX))}
          slotProps={{ htmlInput: { maxLength: DETAILS_MAX } }}
        />
        {publicRoute ? (
          <TextField
            label={t("report.email")}
            helperText={t("report.email.help")}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        ) : null}
        {siteKey ? <HumanCheck turnstile={turnstile} /> : null}
        <Typography
          id={statusId}
          role="alert"
          sx={{ color: hf.danger, minHeight: 20, fontSize: 14 }}
          data-report-problem
        >
          {problem ?? ""}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("report.cancel")}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || !waitOver} aria-describedby={statusId}>
          {busy ? t("report.sending") : t("report.send")}
        </Button>
      </DialogActions>
    </Box>
  );
}

export function ReportDialog({ open, onClose, target }: ReportDialogProps) {
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // The dialog belongs to the account it was opened for: a purge closes it (and its draft goes
  // with the form, which is mounted only while the dialog is open).
  useEffect(() => {
    if (!open) return;
    return registerUserStatePurger(() => closeRef.current());
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth="sm"
      fullWidth
      data-report-dialog
    >
      <DialogTitle id={titleId}>{t("report.title")}</DialogTitle>
      {open ? (
        <ReportForm key={`${target.nodeId}:${target.linkToken ?? ""}`} target={target} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}

/**
 * The quiet "Report" action and its dialog. Without a link token the report needs a signed-in
 * reporter: where nobody is (a public page's preview), there is nothing to offer.
 */
export function ReportLink({ target }: ReportLinkProps) {
  const [open, setOpen] = useState(false);
  if (target.linkToken === undefined && !getCachedSession()) return null;
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)} sx={{ color: hf.textSecondary }} data-report-link>
        {t("report.link")}
      </Button>
      <ReportDialog open={open} onClose={() => setOpen(false)} target={target} />
    </>
  );
}
