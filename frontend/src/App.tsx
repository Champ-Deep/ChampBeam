import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/authClient';
import { ForgotPasswordPage, ResetPasswordPage, SignInPage, SignUpPage } from './pages/AuthPages';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { Navigation } from './components/layout/Navigation';
import { Sidebar } from './components/layout/Sidebar';

import { HomePage } from './pages/HomePage';
import { LandingPage } from './pages/LandingPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { LinksPage } from './pages/LinksPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { LinkAnalyticsPage } from './pages/LinkAnalyticsPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { CampaignComparisonPage } from './pages/CampaignComparisonPage';
import { SettingsPage } from './pages/SettingsPage';
import { FilesPage } from './pages/FilesPage';
import { FileAnalyticsPage } from './pages/FileAnalyticsPage';
import { PagesPage } from './pages/PagesPage';
import { PageAnalyticsPage } from './pages/PageAnalyticsPage';
import { ContentLibraryPage } from './pages/ContentLibraryPage';
import { TeamAnalyticsPage } from './pages/TeamAnalyticsPage';
import { VaultPage } from './pages/VaultPage';
import { useOrgContext } from './hooks/useOrgContext';


// ProtectedRoute and the API 401 handler both send signed-out users to /sign-in.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  return isSignedIn ? <>{children}</> : <Navigate to="/sign-in" replace />;
}

// Requires an active organization. `team` limits to the team-analytics tier
// (admins + leaders). The backend enforces the real authorization — this just
// keeps the UI honest.
function OrgRoute({ team = false, children }: { team?: boolean; children: React.ReactNode }) {
  const { inOrg, canReport, isLoading, error } = useOrgContext();
  if (isLoading) return <p role="status">Loading workspace access…</p>;
  if (error) return <p role="alert">Workspace access could not be verified. Reload or sign in again.</p>;
  if (!inOrg) return <Navigate to="/" replace />;
  if (team && !canReport) return <div className="cb-workspace"><h1>Reporting</h1><p role="alert">Reporting access has not been granted in this workspace.</p></div>;
  return <>{children}</>;
}

// App chrome. Signed-in users get the App v2 dark sidebar with the content
// scrolling to its right; signed-out visitors keep the marketing top nav so the
// landing page reads full-width. Wait for the session before choosing chrome,
// so a signed-in user never sees the marketing bar flash in.
function Chrome({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) {
    return <main id="main-content"><p role="status">Loading account…</p></main>;
  }
  if (isSignedIn) {
    return (
      <div className="flex min-h-screen flex-col md:flex-row">
        <Sidebar />
        <main id="main-content" className="min-w-0 flex-1">{children}</main>
      </div>
    );
  }
  return (
    <>
      <Navigation />
      <main id="main-content">{children}</main>
    </>
  );
}

// '/' is the landing for guests and the work screen for members. Hold both
// until the session is known so neither screen flashes, and do not redirect:
// sign-in already sends members back to '/', so a redirect here would loop.
function HomeRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p role="status">Loading account…</p>;
  return isSignedIn ? <HomePage /> : <LandingPage />;
}

export default function App() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--cb-bg)' }}>
      <AnnouncementBanner />
      <Routes>
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/sign-up/*" element={<SignUpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="*" element={
          <Chrome>
            <Routes>
                <Route path="/" element={<HomeRoute />} />
                {/* /welcome retired: signed-out / is the landing, signed-in / is the work screen. */}
                <Route path="/welcome" element={<Navigate to="/" replace />} />
                {/* Presets moved into Settings. Redirect the old route so existing links don't 404. */}
                <Route path="/presets" element={<Navigate to="/links?tab=utm&panel=presets" replace />} />
                <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
                <Route path="/performance" element={<Navigate to="/analytics" replace />} />
                <Route path="/links" element={<ProtectedRoute><LinksPage /></ProtectedRoute>} />
                <Route path="/projects" element={<Navigate to="/links" replace />} />
                <Route path="/projects/:projectId" element={<ProtectedRoute><ProjectDetailPage /></ProtectedRoute>} />
                <Route path="/analytics/link/:linkId" element={<ProtectedRoute><LinkAnalyticsPage /></ProtectedRoute>} />
                {/* Campaign list rolled into the Analytics "Campaigns" tab. Detail + compare views stay. */}
                <Route path="/campaigns" element={<Navigate to="/analytics?tab=campaigns" replace />} />
                <Route path="/campaigns/compare" element={<ProtectedRoute><CampaignComparisonPage /></ProtectedRoute>} />
                <Route path="/campaigns/:campaignName" element={<ProtectedRoute><CampaignDetailPage /></ProtectedRoute>} />
                <Route path="/files" element={<ProtectedRoute><FilesPage /></ProtectedRoute>} />
                <Route path="/files/:fileId/analytics" element={<ProtectedRoute><FileAnalyticsPage /></ProtectedRoute>} />
                <Route path="/pages" element={<ProtectedRoute><PagesPage /></ProtectedRoute>} />
                <Route path="/pages/:pageId/analytics" element={<ProtectedRoute><PageAnalyticsPage /></ProtectedRoute>} />
                <Route path="/vault" element={<ProtectedRoute><VaultPage /></ProtectedRoute>} />
                <Route path="/library" element={<ProtectedRoute><OrgRoute><ContentLibraryPage /></OrgRoute></ProtectedRoute>} />
                <Route path="/team" element={<ProtectedRoute><OrgRoute team><TeamAnalyticsPage /></OrgRoute></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
            </Routes>
          </Chrome>
        } />
      </Routes>
    </div>
  );
}
