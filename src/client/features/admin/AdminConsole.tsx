// /admin/*: the operator's console — a lazy chunk (./routes.tsx), so none of it is shipped to an
// account that never opens it. Rendered inside the frame's AccountKeyed: an identity change
// remounts it, and nothing of one account's console stays on screen for another. Every screen
// reads on navigation and on Refresh, never on a timer; every one renders an error state when its
// read fails.
import Box from "@mui/material/Box";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { hf, layout } from "../../theme/tokens";
import { Dashboard } from "./pages/Dashboard";
import { DmcaDetailPage, DmcaPage } from "./pages/Dmca";
import { AuditPage } from "./pages/Audit";
import { InvitesPage } from "./pages/Invites";
import { KeptUploadsPage } from "./pages/KeptUploads";
import { LinksPage } from "./pages/Links";
import { LockCsamPage } from "./pages/LockCsam";
import { QuarantineDetailPage, QuarantinePage } from "./pages/Quarantine";
import { ReportDetailPage, ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
import { SystemPage } from "./pages/System";
import { UserDetailPage, UsersPage } from "./pages/Users";
import { StepUpProvider } from "./StepUp";
import { t, type AdminMessage } from "./strings";

const SECTIONS: ReadonlyArray<{ path: string; label: AdminMessage }> = [
  { path: "", label: "nav.dashboard" },
  { path: "users", label: "nav.users" },
  { path: "reports", label: "nav.reports" },
  { path: "quarantine", label: "nav.quarantine" },
  { path: "kept-uploads", label: "nav.kept" },
  { path: "lock-csam", label: "nav.lockCsam" },
  { path: "dmca", label: "nav.dmca" },
  { path: "links", label: "nav.links" },
  { path: "invites", label: "nav.invites" },
  { path: "audit", label: "nav.audit" },
  { path: "settings", label: "nav.settings" },
  { path: "system", label: "nav.system" },
];

function SectionNav() {
  return (
    <Box
      component="nav"
      aria-label={t("nav.label")}
      sx={{
        display: "flex",
        gap: 1,
        overflowX: "auto",
        borderBottom: `1px solid ${hf.hairline}`,
        marginBottom: 3,
      }}
    >
      {SECTIONS.map((section) => (
        <Box
          key={section.path}
          component={NavLink}
          to={section.path === "" ? "/admin" : `/admin/${section.path}`}
          end={section.path === ""}
          data-admin-nav={section.path || "dashboard"}
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
          }}
        >
          {t(section.label)}
        </Box>
      ))}
    </Box>
  );
}

export function AdminConsole() {
  return (
    <StepUpProvider>
      <Box
        data-admin-page
        sx={{ padding: { xs: 2, md: 4 }, display: "flex", flexDirection: "column", minWidth: 0 }}
      >
        <SectionNav />
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="users/:userId" element={<UserDetailPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/:reportId" element={<ReportDetailPage />} />
          <Route path="quarantine" element={<QuarantinePage />} />
          <Route path="quarantine/:nodeId" element={<QuarantineDetailPage />} />
          <Route path="kept-uploads" element={<KeptUploadsPage />} />
          <Route path="lock-csam" element={<LockCsamPage />} />
          <Route path="dmca" element={<DmcaPage />} />
          <Route path="dmca/:noticeId" element={<DmcaDetailPage />} />
          <Route path="links" element={<LinksPage />} />
          <Route path="invites" element={<InvitesPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Box>
    </StepUpProvider>
  );
}
