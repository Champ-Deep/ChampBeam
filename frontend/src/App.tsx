import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { Navigation } from './components/layout/Navigation';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { HomePage } from './pages/HomePage';
import { PresetsPage } from './pages/PresetsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { PerformancePage } from './pages/PerformancePage';
import { BulkPage } from './pages/BulkPage';
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
                <Route path="/performance" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><PerformancePage /></ProtectedRoute>
                } />
                <Route path="/bulk" element={
                  <ProtectedRoute isAuthenticated={isAuthenticated}><BulkPage /></ProtectedRoute>
                } />
              </Routes>
            </main>
          </>
        } />
      </Routes>
    </div>
  );
}
