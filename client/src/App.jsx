import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import AppShell from './components/AppShell.jsx';
import ErrorBoundary, { RouteError } from './components/ErrorBoundary.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import { PageLoader } from './components/ui/Blocks.jsx';

import AcceptInvite from './pages/AcceptInvite.jsx';
import AuthLayout from './pages/AuthLayout.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import Login from './pages/Login.jsx';
import NotFound from './pages/NotFound.jsx';
import Register from './pages/Register.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';

/*
 * Signed-in pages are code-split, as the PHP edition's router imported each
 * view on first visit: a session that never opens Reports never downloads it.
 */
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Leads = lazy(() => import('./pages/Leads.jsx'));
const LeadDetail = lazy(() => import('./pages/LeadDetail.jsx'));
const Projects = lazy(() => import('./pages/Projects.jsx'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail.jsx'));
const Communication = lazy(() => import('./pages/Communication.jsx'));
const PlatformDashboard = lazy(() => import('./pages/PlatformDashboard.jsx'));
const Clients = lazy(() => import('./pages/Clients.jsx'));
const ClientDetail = lazy(() => import('./pages/ClientDetail.jsx'));
const Forms = lazy(() => import('./pages/Forms.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Performance = lazy(() => import('./pages/Performance.jsx'));
const Activities = lazy(() => import('./pages/Activities.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Teams = lazy(() => import('./pages/Teams.jsx'));
const Roles = lazy(() => import('./pages/Roles.jsx'));
const Automation = lazy(() => import('./pages/Automation.jsx'));
const Imports = lazy(() => import('./pages/Imports.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Developers = lazy(() => import('./pages/Developers.jsx'));
const Integrations = lazy(() => import('./pages/Integrations.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Security = lazy(() => import('./pages/Security.jsx'));
const Sessions = lazy(() => import('./pages/Sessions.jsx'));

/**
 * Wraps one routed page: a loader while its chunk downloads, and the PHP
 * router's `renderRouteError()` if it fails to load or throws while
 * rendering, so one broken page never blanks the shell.
 *
 * Keyed by pathname, which gives the original router's lifecycle: moving to
 * a different path (including /leads/1 → /leads/2) mounts the page afresh
 * and clears any error, while a change to the query string alone keeps the
 * page mounted - that was the view's `onQuery` hook, and is now a page
 * reading `useSearchParams()`.
 */
function RouteView({ children }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary
      key={pathname}
      fallback={(error) => <RouteError error={error} />}
      onError={(err) => console.error('[router] failed to render', pathname, err)}
    >
      <Suspense fallback={<PageLoader />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

const page = (Component) => (
  <RouteView>
    <Component />
  </RouteView>
);

/**
 * Route table.
 *
 * Two shells: the split-screen brand panel for anything a signed-out visitor
 * can reach, and the sidebar application for everything behind a session.
 * `RequireAuth` only redirects — the server re-checks the session and the
 * permission on every call it serves. Paths are the PHP edition's hash routes
 * without the hash (`#/leads/42` → `/leads/42`).
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
      </Route>

      <Route path="/index.html" element={<Navigate to="/" replace />} />
      <Route path="/login.html" element={<Navigate to="/login" replace />} />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={page(Dashboard)} />
        <Route path="/leads" element={page(Leads)} />
        <Route path="/leads/:id" element={page(LeadDetail)} />
        <Route path="/projects" element={page(Projects)} />
        <Route path="/projects/:id" element={page(ProjectDetail)} />
        <Route path="/communication" element={page(Communication)} />
        <Route path="/platform" element={page(PlatformDashboard)} />
        <Route path="/clients" element={page(Clients)} />
        <Route path="/clients/:id" element={page(ClientDetail)} />
        <Route path="/forms" element={page(Forms)} />
        <Route path="/reports" element={page(Reports)} />
        <Route path="/performance" element={page(Performance)} />
        <Route path="/activities" element={page(Activities)} />
        <Route path="/notifications" element={page(Notifications)} />
        <Route path="/users" element={page(Users)} />
        <Route path="/teams" element={page(Teams)} />
        <Route path="/roles" element={page(Roles)} />
        <Route path="/automation" element={page(Automation)} />
        <Route path="/imports" element={page(Imports)} />
        <Route path="/settings" element={page(Settings)} />
        <Route path="/developers" element={page(Developers)} />
        <Route path="/integrations" element={page(Integrations)} />
        <Route path="/audit" element={page(Audit)} />
        <Route path="/profile" element={page(Profile)} />
        <Route path="/security" element={page(Security)} />
        <Route path="/sessions" element={page(Sessions)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
