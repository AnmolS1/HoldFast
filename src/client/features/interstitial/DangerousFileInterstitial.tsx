// The warning before a public-link download of a type that can run code (T08's
// `DangerousFileInterstitial` slot). Which files get it is the server's decision (`dangerous` on
// the link's info, or the mint's refusal without `dangerousAck`); this component says in one
// sentence what that kind of file can do, and goes on ONLY on an explicit choice — never on
// mount, never on Enter by reflex (focus starts on Cancel). Escape and the backdrop cancel.
import Typography from "@mui/material/Typography";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { DangerousFileInterstitialProps } from "../../components/slots";
import { dangerKind } from "./kind";
import { t } from "./strings";

export function DangerousFileInterstitial({
  fileName,
  onContinue,
  onCancel,
}: DangerousFileInterstitialProps) {
  const kind = dangerKind(fileName);
  return (
    <ConfirmDialog
      open
      title={t("danger.title", { name: fileName })}
      consequence={
        <>
          <Typography component="span" sx={{ display: "block", mb: 1 }} data-danger-kind={kind}>
            {t(`danger.${kind}`)}
          </Typography>
          <Typography component="span" sx={{ display: "block" }}>
            {t("danger.trust")}
          </Typography>
        </>
      }
      confirmLabel={t("danger.continue")}
      cancelLabel={t("danger.cancel")}
      onConfirm={onContinue}
      onCancel={onCancel}
    />
  );
}
