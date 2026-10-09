import Box from "@mui/material/Box";
import { Link as RouterLink } from "react-router";
import { EXTERNAL_LINKS } from "../../lib/contracts";
import { t } from "../../lib/i18n";
import { hf } from "../../theme/tokens";

// Each link is its own target: 24 px tall with a pointer, 44 px on a touch layout.
const linkSx = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 24,
  padding: "0 4px",
  color: hf.textSecondary,
  textDecoration: "underline",
  textUnderlineOffset: "2px",
  "&:hover": { color: hf.text },
  "@media (max-width:1023.95px)": { minHeight: 44, minWidth: 44, justifyContent: "center" },
} as const;

/** Terms · Privacy · DMCA · Support. Public pages render it as their footer. */
export function LegalFooter() {
  return (
    <Box component="nav" aria-label={t("legal.footer")} sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 12px", padding: 4, fontSize: 12, color: hf.textSecondary }}>
      <Box component="a" href={EXTERNAL_LINKS.terms} rel="noopener" sx={linkSx}>
        {t("legal.terms")}
      </Box>
      <Box component="a" href={EXTERNAL_LINKS.privacy} rel="noopener" sx={linkSx}>
        {t("legal.privacy")}
      </Box>
      <Box component={RouterLink} to="/dmca" sx={linkSx}>
        {t("legal.dmca")}
      </Box>
      <Box component="a" href={EXTERNAL_LINKS.help} rel="noopener" sx={linkSx}>
        {t("legal.support")}
      </Box>
    </Box>
  );
}
