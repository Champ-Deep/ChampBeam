import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { Navigation } from './components/layout/Navigation';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { LoadingSpinner } from './components/ui/LoadingSpinner';

// Lazy placeholder pages (will be built in later phases)
function HomePage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">UTM Link Generator</h1>
      <p className="text-slate-600">Generate UTM-tagged URLs for your marketing campaigns.</p>
      <div className="mt-8 p-8 bg-white rounded-xl border border-slate-200 text-center text-slate-500">
        Link generator coming in Phase 6
      </div>
    </div>
  );
}

function PresetsPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">UTM Presets</h1>
      <p className="text-slate-600">Save and reuse UTM parameter templates.</p>
      <div className="mt-8 p-8 bg-white rounded-xl border border-slate-200 text-center text-slate-500">
        Presets page coming in Phase 7
      </div>
    </div>
  );
}

function AnalyticsPage() {
  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">Analytics</h1>
      <p className="text-slate-600">Track UTM performance and click analytics.</p>
      <div className="mt-8 p-8 bg-white rounded-xl border border-slate-200 text-center text-slate-500">
        Analytics page coming in Phase 8
      </div>
    </div>
  );
}

function PerformancePage() {
  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">Link Performance</h1>
      <p className="text-slate-600">View individual link performance metrics.</p>
      <div className="mt-8 p-8 bg-white rounded-xl border border-slate-200 text-center text-slate-500">
        Performance page coming in Phase 9
      </div>
    </div>
  );
}

function BulkPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">Bulk Generator</h1>
      <p className="text-slate-600">Process multiple URLs at once with CSV upload.</p>
      <div className="mt-8 p-8 bg-white rounded-xl border border-slate-200 text-center text-slate-500">
        Bulk generator coming in Phase 9
      </div>
    </div>
  );
}

// Protected route wrapper
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
                <Route path="/" element={<HomePage />} />
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
