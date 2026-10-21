// /account/*: one page, five sections, each at its own address (/account, /account/preferences,
// /account/security, /account/devices, /account/data). Rendered inside the frame's AccountKeyed,
// so nothing of one account is kept on screen for another.
import Box from "@mui/material/Box";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { hf, layout } from "../../theme/tokens";
import { DataSection } from "./DataSection";
import { DevicesSection } from "./DevicesSection";
import { PreferencesSection } from "./PreferencesSection";
import { ProfileSection } from "./ProfileSection";
import { SecuritySection } from "./SecuritySection";
import { t, type AccountMessage } from "./strings";

const SECTIONS: ReadonlyArray<{ path: string; label: AccountMessage }> = [
  { path: "", label: "account.section.profile" },
  { path: "preferences", label: "account.section.preferences" },
  { path: "security", label: "account.section.security" },
  { path: "devices", label: "account.section.devices" },
  { path: "data", label: "account.section.data" },
];

function SectionNav() {
  return (
    <Box
      component="nav"
      aria-label={t("account.nav")}
      sx={{
        display: "flex",
        gap: 1,
        overflowX: "auto",
        borderBottom: `1px solid ${hf.hairline}`,
        marginBottom: 5,
      }}
    >
      {SECTIONS.map((section) => (
        <Box
          key={section.path}
          component={NavLink}
          to={section.path === "" ? "/account" : `/account/${section.path}`}
          end
          data-account-nav={section.path || "profile"}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: layout.touchTarget,
            padding: "0 12px",
            color: hf.textSecondary,
            textDecoration: "none",
            whiteSpace: "nowrap",
            borderBottom: "2px solid transparent",
            "&.active": { color: hf.text, borderBottomColor: hf.text, fontWeight: 600 },
            "&:hover": { color: hf.text },
          }}
        >
          {t(section.label)}
        </Box>
      ))}
    </Box>
  );
}

export function AccountPage() {
  return (
    <Box data-account-page sx={{ padding: 5, maxWidth: 720, width: "100%", boxSizing: "border-box" }}>
      <SectionNav />
      <Routes>
        <Route index element={<ProfileSection />} />
        <Route path="preferences" element={<PreferencesSection />} />
        <Route path="security" element={<SecuritySection />} />
        <Route path="devices" element={<DevicesSection />} />
        <Route path="data" element={<DataSection />} />
        <Route path="*" element={<Navigate to="/account" replace />} />
      </Routes>
    </Box>
  );
}
