import { Routes, Route, Navigate } from 'react-router-dom';
import { SignedIn, SignedOut, RedirectToSignIn, SignIn, SignUp, useAuth } from '@clerk/clerk-react';
import { useEffect } from 'react';
import { Navigation } from './components/layout/Navigation';
import { HomePage } from './pages/HomePage';
import { PresetsPage } from './pages/PresetsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { LinksPage } from './pages/LinksPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { LinkAnalyticsPage } from './pages/LinkAnalyticsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { CampaignComparisonPage } from './pages/CampaignComparisonPage';
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
      <SignedIn>{children}</SignedIn>
      <SignedOut><RedirectToSignIn /></SignedOut>
    </>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <ClerkTokenSync />
      <Routes>
        {/* Clerk auth pages */}
        <Route path="/sign-in/*" element={<SignIn routing="path" path="/sign-in" />} />
        <Route path="/sign-up/*" element={<SignUp routing="path" path="/sign-up" />} />

        {/* Main app with nav */}
        <Route path="*" element={
          <>
            <Navigation />
            <main>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/presets" element={<ProtectedRoute><PresetsPage /></ProtectedRoute>} />
                <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
                <Route path="/performance" element={<Navigate to="/analytics" replace />} />
                <Route path="/links" element={<ProtectedRoute><LinksPage /></ProtectedRoute>} />
                <Route path="/projects" element={<Navigate to="/links" replace />} />
                <Route path="/projects/:projectId" element={<ProtectedRoute><ProjectDetailPage /></ProtectedRoute>} />
                <Route path="/analytics/link/:linkId" element={<ProtectedRoute><LinkAnalyticsPage /></ProtectedRoute>} />
                <Route path="/campaigns" element={<ProtectedRoute><CampaignsPage /></ProtectedRoute>} />
                <Route path="/campaigns/compare" element={<ProtectedRoute><CampaignComparisonPage /></ProtectedRoute>} />
                <Route path="/campaigns/:campaignName" element={<ProtectedRoute><CampaignDetailPage /></ProtectedRoute>} />
              </Routes>
            </main>
          </>
        } />
      </Routes>
    </div>
  );
}
