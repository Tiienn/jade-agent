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
import Invoices from './pages/Invoices'
import LeasePlans from './pages/LeasePlans'
import Attendance from './pages/Report'
import Leave from './pages/Leave'
import Calendar from './pages/Calendar'
import ComingSoon from './pages/ComingSoon'
import Share from './pages/Share'
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

      <Route
        path="/invoices"
        element={
          <ProtectedRoute>
            <Layout>
              <Invoices />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* Staff attendance board. The roster panel inside is admin-gated by the
          page itself, so the route stays open to every signed-in user. */}
      <Route
        path="/attendance"
        element={
          <ProtectedRoute>
            <Layout>
              <Attendance />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* Leave requests. Open to every signed-in user: the request form, the
          "my requests" list and the approval queue are each gated inside the
          page by whether the user is on the roster, and by who a request was
          routed to. */}
      <Route
        path="/leave"
        element={
          <ProtectedRoute>
            <Layout>
              <Leave />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* Meetings and dated notes. Open to every signed-in user: reading the
          diary and organising a meeting need nothing but a login, and the two
          things that do need a roster row — being invited, and answering an
          invitation — are gated inside the page. */}
      <Route
        path="/calendar"
        element={
          <ProtectedRoute>
            <Layout>
              <Calendar />
            </Layout>
          </ProtectedRoute>
        }
      />

      <Route path="/lease-plans" element={<ProtectedRoute><Layout><LeasePlans /></Layout></ProtectedRoute>} />

      <Route path="/share" element={<ProtectedRoute><Layout><Share /></Layout></ProtectedRoute>} />

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
