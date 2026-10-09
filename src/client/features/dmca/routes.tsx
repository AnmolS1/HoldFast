// PLACEHOLDER — taken over by the legal task (T29), which replaces this module and keeps the `routes` export.
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";

// Public: reachable signed out, outside the app frame.
export const routes: RouteObject[] = [
  {
    path: "dmca",
    element: (
      <Box component="main" sx={{ maxWidth: 640, margin: "0 auto", padding: 6 }}>
        <Typography variant="h1">{t("legal.dmca")}</Typography>
        <Typography sx={{ marginTop: 3 }}>{t("app.preparing")}</Typography>
      </Box>
    ),
    handle: { public: true },
  },
];
