// "A file with this name is already here": replace it, keep both, or skip — once, or for every
// other conflict of the upload. The shared confirm dialog has two answers; this question has three.
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import { useId, useState, type ReactNode } from "react";
import { useInitialFocus } from "../../components/focus";
import { hf } from "../../theme/tokens";
import { resolveConflict, type ConflictChoice } from "./manager";
import type { UploadItem } from "./store";
import { t } from "./strings";

/** Skip takes the initial focus: Enter by reflex changes nothing. */
function SkipButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  const ref = useInitialFocus<HTMLButtonElement>();
  return (
    <Button ref={ref} onClick={onClick}>
      {children}
    </Button>
  );
}

function Question({ item }: { item: UploadItem }) {
  const titleId = useId();
  const bodyId = useId();
  const [all, setAll] = useState(false);
  const refused = item.conflict?.replaceRefused ?? null;
  const canReplace = Boolean(item.conflict?.existingId) && !refused;
  const answer = (choice: ConflictChoice) => resolveConflict(item.id, choice, all);
  return (
    <Dialog
      open
      onClose={() => answer("skip")}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: "anywhere" }}>
        {t("conflict.title", { name: item.name })}
      </DialogTitle>
      <DialogContent>
        <Typography id={bodyId} component="div" sx={{ color: hf.textSecondary }}>
          {/* A refused replace is shown in the server's own words. */}
          {refused ?? (canReplace ? t("conflict.body") : t("conflict.bodyNoReplace"))}
        </Typography>
        <FormControlLabel
          control={<Checkbox checked={all} onChange={(event) => setAll(event.target.checked)} />}
          label={t("conflict.all")}
          sx={{ marginTop: 2 }}
        />
      </DialogContent>
      <DialogActions>
        <SkipButton onClick={() => answer("skip")}>{t("conflict.skip")}</SkipButton>
        <Button onClick={() => answer("rename")}>{t("conflict.keepBoth")}</Button>
        {canReplace ? (
          <Button variant="contained" onClick={() => answer("replace")}>
            {t("conflict.replace")}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

/** One question at a time: the first file that waits for an answer. */
export function ConflictDialog({ items }: { items: readonly UploadItem[] }) {
  const item = items.find((candidate) => candidate.state === "conflict");
  // Keyed by the file, so "do the same for every other" starts unticked for each question.
  return item ? <Question key={item.id} item={item} /> : null;
}
