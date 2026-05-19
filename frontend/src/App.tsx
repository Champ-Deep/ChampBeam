import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { Navigation } from './components/layout/Navigation';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { HomePage } from './pages/HomePage';
import { PresetsPage } from './pages/PresetsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { LinksPage } from './pages/LinksPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { LinkAnalyticsPage } from './pages/LinkAnalyticsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { CampaignComparisonPage } from './pages/CampaignComparisonPage';
import { LoadingSpinner } from './components/ui/LoadingSpinner';

function ProtectedRoute({ children, isAuthenticated }: { children: React.ReactNode; isAuthenticated: boolean }) {
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const { isAuthenticated, isLoading, login, register, logout } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Routes>
        {/* Auth pages (no nav) */}
        <Route path="/login" element={
          isAuthenticated ? <Navigate to="/" replace /> : <LoginPage onLogin={login} />
        } />
        <Route path="/register" element={
          isAuthenticated ? <Navigate to="/" replace /> : <RegisterPage onRegister={register} />
        } />

        {/* Main app with nav */}
        <Route path="*" element={
          <>
            <Navigation isAuthenticated={isAuthenticated} onLogout={logout} />
            <main>
              <Routes>
                <Route path="/" element={<HomePage isAuthenticated={isAuthenticated} />} />
                <Route path="/presets" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><PresetsPage /></ProtectedRoute>
                } />
                <Route path="/analytics" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><AnalyticsPage /></ProtectedRoute>
                } />
                <Route path="/performance" element={<Navigate to="/analytics" replace />} />
                <Route path="/links" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><LinksPage /></ProtectedRoute>
                } />
                <Route path="/projects" element={<Navigate to="/links" replace />} />
                <Route path="/projects/:projectId" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><ProjectDetailPage /></ProtectedRoute>
                } />
                <Route path="/analytics/link/:linkId" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><LinkAnalyticsPage /></ProtectedRoute>
                } />
                <Route path="/campaigns" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><CampaignsPage /></ProtectedRoute>
                } />
                <Route path="/campaigns/compare" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><CampaignComparisonPage /></ProtectedRoute>
                } />
                <Route path="/campaigns/:campaignName" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><CampaignDetailPage /></ProtectedRoute>
                } />
              </Routes>
            </main>
          </>
        } />
      </Routes>
    </div>
  );
}
