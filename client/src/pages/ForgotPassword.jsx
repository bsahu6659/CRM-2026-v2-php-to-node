import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api.js';
import Alert from '../components/Alert.jsx';
import Field from '../components/Field.jsx';
import { Spinner } from '../components/Spinner.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/api/auth/forgot-password', { email: email.trim() });
      setDone(res.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <h1>Check your email</h1>
        <p className="sub">{done.message}</p>
        {/* Outside production the server returns the link itself, because a
            development install usually has no SMTP server configured. */}
        {done.resetUrl && (
          <div style={{ marginBottom: 16 }}>
            <Alert tone="warning" title="Development mode">
              No mail server is configured, so the link is shown here instead:
              <br />
              <Link to={new URL(done.resetUrl).pathname + new URL(done.resetUrl).search}>Open reset link</Link>
            </Alert>
          </div>
        )}
        <Link className="btn btn-block" to="/login">
          Back to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h1>Reset your password</h1>
      <p className="sub">We will email you a link that is valid for one hour.</p>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <Field label="Work email" htmlFor="email" required>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
          {busy ? <Spinner /> : 'Send reset link'}
        </button>
      </form>

      <p className="small muted" style={{ marginTop: 18 }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </>
  );
}
