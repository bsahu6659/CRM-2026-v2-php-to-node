import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import Alert from '../components/Alert.jsx';
import Field from '../components/Field.jsx';
import { Spinner } from '../components/Spinner.jsx';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();

  const [form, setForm] = useState({ password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/reset-password', { token, password: form.password });
      // Every session was revoked server-side, so there is nothing to keep.
      navigate('/login', { replace: true, state: { notice: 'Password updated. Please sign in.' } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <>
        <h1>Reset link missing</h1>
        <p className="sub">This page needs the token from the email we sent you.</p>
        <Link className="btn btn-primary btn-block" to="/forgot-password">
          Request a new link
        </Link>
      </>
    );
  }

  return (
    <>
      <h1>Set a new password</h1>
      <p className="sub">Choose something you have not used here before.</p>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <Field
          label="New password"
          htmlFor="password"
          hint="At least 10 characters, with upper and lower case and a digit."
          required
        >
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
            required
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm" required>
          <input
            id="confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={set('confirm')}
            required
          />
        </Field>
        <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
          {busy ? <Spinner /> : 'Update password'}
        </button>
      </form>
    </>
  );
}
