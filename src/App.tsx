import { Routes, Route, Navigate } from 'react-router-dom'
import { PinsProvider } from './context/PinsContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Search from './pages/Search'
import Browse from './pages/Browse'
import Advert from './pages/Advert'
import Email from './pages/Email'
import ComingSoon from './pages/ComingSoon'
import { FEATURE_LINKS } from './lib/featureLinks'
import Dashboard from './pages/admin/Dashboard'
import Users from './pages/admin/Users'
import Settings from './pages/admin/Settings'

export default function App() {
  return (
    <PinsProvider>
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout>
              <Search />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/browse"
        element={
          <ProtectedRoute>
            <Layout>
              <Browse />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <Dashboard />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <Users />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute requireAdmin>
            <Layout>
              <Settings />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/advert"
        element={
          <ProtectedRoute>
            <Layout>
              <Advert />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* Must stay exactly /email — mail-callback redirects the browser here
          with ?connected=1 or ?error=<code> after Microsoft consent. */}
      <Route
        path="/email"
        element={
          <ProtectedRoute>
            <Layout>
              <Email />
            </Layout>
          </ProtectedRoute>
        }
      />

      {FEATURE_LINKS.map((f) => (
        <Route
          key={f.to}
          path={f.to}
          element={
            <ProtectedRoute>
              <Layout>
                <ComingSoon title={f.label} icon={f.icon} />
              </Layout>
            </ProtectedRoute>
          }
        />
      ))}

      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PinsProvider>
  )
}
