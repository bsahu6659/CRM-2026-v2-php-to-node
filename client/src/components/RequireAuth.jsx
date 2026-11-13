import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { PageLoader } from './Spinner.jsx';

/**
 * Route guard. This is convenience, not security — every endpoint behind it
 * re-checks the session and the permission server-side, because a client-side
 * guard is only a redirect and anyone can skip a redirect.
 *
 * The failure screen is the PHP edition's boot error: the session request
 * failed for a reason other than "signed out", so there is nothing to render
 * the shell with.
 */
export default function RequireAuth({ children }) {
  const { status, error } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader label="Loading Growvanta CRM…" />;

  if (status === 'error') {
    return (
      <div className="page-loader">
        <div className="alert danger" role="alert">
          <div>
            <strong>Could not reach the server</strong>
            {error?.message}
            <div className="mt-16">
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status !== 'signed-in') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}
