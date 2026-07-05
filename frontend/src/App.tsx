import { Routes, Route, Navigate } from 'react-router-dom';
import { Show, useAuth } from '@clerk/react';
import { useEffect } from 'react';
import { Navigation } from './components/layout/Navigation';
import { HomePage } from './pages/HomePage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { LinksPage } from './pages/LinksPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { LinkAnalyticsPage } from './pages/LinkAnalyticsPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { CampaignComparisonPage } from './pages/CampaignComparisonPage';
import { SettingsPage } from './pages/SettingsPage';
import { FilesPage } from './pages/FilesPage';
import { FileAnalyticsPage } from './pages/FileAnalyticsPage';
import { ContentLibraryPage } from './pages/ContentLibraryPage';
import { TeamAnalyticsPage } from './pages/TeamAnalyticsPage';
import { VaultPage } from './pages/VaultPage';
import { useOrgContext } from './hooks/useOrgContext';
import { setTokenGetter } from './api/client';

function ClerkTokenSync() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(() => getToken());
  }, [getToken]);
  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out"><Navigate to="/sign-in" replace /></Show>
    </>
  );
}

// Requires an active organization. `team` limits to the team-analytics tier
// (admins + leaders). The backend enforces the real authorization — this just
// keeps the UI honest.
function OrgRoute({ team = false, children }: { team?: boolean; children: React.ReactNode }) {
  const { inOrg, canManageTeam } = useOrgContext();
  if (!inOrg) return <Navigate to="/" replace />;
  if (team && !canManageTeam) return <Navigate to="/library" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <ClerkTokenSync />
      <Routes>
        <Route path="*" element={
          <>
            <Navigation />
            <main>
              <Routes>
                <Route path="/" element={<HomePage />} />
                {/* /welcome retired: the home page now serves both the marketing
                    content (signed-out) and the full app (signed-in). */}
                <Route path="/welcome" element={<Navigate to="/" replace />} />
                {/* Presets moved into Settings. Redirect the old route so existing links don't 404. */}
                <Route path="/presets" element={<Navigate to="/settings?tab=presets" replace />} />
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
                <Route path="/vault" element={<ProtectedRoute><VaultPage /></ProtectedRoute>} />
                <Route path="/library" element={<ProtectedRoute><OrgRoute><ContentLibraryPage /></OrgRoute></ProtectedRoute>} />
                <Route path="/team" element={<ProtectedRoute><OrgRoute team><TeamAnalyticsPage /></OrgRoute></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
              </Routes>
            </main>
          </>
        } />
      </Routes>
    </div>
  );
}
