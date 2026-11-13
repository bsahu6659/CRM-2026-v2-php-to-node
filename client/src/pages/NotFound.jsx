import { Link, useLocation } from 'react-router-dom';
import { EmptyState } from '../components/ui/Blocks.jsx';

/** The PHP edition's not-found view, rendered inside the shell for any unknown path. */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="card">
      <EmptyState
        iconName="search"
        title="Page not found"
        message={`Nothing lives at ${pathname}.`}
        action={
          <Link className="btn btn-primary" to="/">
            Back to dashboard
          </Link>
        }
      />
    </div>
  );
}
