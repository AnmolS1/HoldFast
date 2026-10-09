import Box from "@mui/material/Box";
import { Link as RouterLink, Outlet } from "react-router";
import { LegalFooter } from "../../components/LegalFooter";
import { Wordmark } from "../../components/Mark";
import { t } from "../../lib/i18n";
import { hf } from "../../theme/tokens";

/** The frame of every signed-out screen: wordmark, one card, the legal links. */
export function AuthLayout() {
  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        backgroundColor: hf.bg,
        padding: { xs: "24px 16px", md: "64px 16px 24px" },
      }}
    >
      <Box component="header" sx={{ width: "100%", maxWidth: 400, marginBottom: 4 }}>
        <Box
          component={RouterLink}
          to="/login"
          aria-label={t("nav.home")}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            color: hf.text,
            textDecoration: "none",
          }}
        >
          <Wordmark />
        </Box>
      </Box>
      <Box component="main" id="main" sx={{ width: "100%", maxWidth: 400, flex: "1 0 auto" }}>
        <Outlet />
      </Box>
      <Box component="footer" sx={{ marginTop: 4 }}>
        <LegalFooter />
      </Box>
    </Box>
  );
}
