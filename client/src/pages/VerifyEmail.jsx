import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import Alert from '../components/Alert.jsx';
import { PageLoader } from '../components/Spinner.jsx';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState(token ? 'verifying' : 'missing');
  const [error, setError] = useState('');
  // React 18 StrictMode mounts effects twice in development, and the token is
  // single-use: the second call would report the link as already consumed.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api
      .post('/api/auth/verify-email', { token })
      .then(() => setState('verified'))
      .catch((err) => {
        setError(err.message);
        setState('failed');
      });
  }, [token]);

  if (state === 'verifying') return <PageLoader label="Confirming your email address…" />;

  return (
    <>
      <h1>{state === 'verified' ? 'Email confirmed' : 'Could not confirm'}</h1>
      <p className="sub">
        {state === 'verified'
          ? 'Your email address is verified. You can sign in as usual.'
          : state === 'missing'
            ? 'This page needs the token from the email we sent you.'
            : error}
      </p>
      {state !== 'verified' && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warning">
            Verification links expire after 24 hours and work only once. Sign in and request a new one from the
            Security page.
          </Alert>
        </div>
      )}
      <Link className="btn btn-primary btn-block" to="/login">
        Go to sign in
      </Link>
    </>
  );
}
