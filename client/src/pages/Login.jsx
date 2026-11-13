import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Alert from '../components/Alert.jsx';
import Field from '../components/Field.jsx';
import { Spinner } from '../components/Spinner.jsx';

export default function Login() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '', twoFactorCode: '', rememberMe: false });
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  if (status === 'signed-in') return <Navigate to={location.state?.from || '/'} replace />;

  const set = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const payload = {
        email: form.email.trim(),
        password: form.password,
        rememberMe: form.rememberMe,
      };
      if (needsCode) payload.twoFactorCode = form.twoFactorCode.trim();

      const result = await signIn(payload);
      if (result.twoFactorRequired) {
        setNeedsCode(true);
        setBusy(false);
        return;
      }
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in</h1>
      <p className="sub">Welcome back. Enter your credentials to continue.</p>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <Field label="Work email" htmlFor="email" error={fieldErrors.email} required>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            value={form.email}
            onChange={set('email')}
            disabled={needsCode}
            required
          />
        </Field>

        <Field label="Password" htmlFor="password" error={fieldErrors.password} required>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={set('password')}
            disabled={needsCode}
            required
          />
        </Field>

        {needsCode && (
          <Field
            label="Authenticator code"
            htmlFor="twoFactorCode"
            hint="Six digits from your authenticator app."
            error={fieldErrors.twoFactorCode}
            required
          >
            <input
              id="twoFactorCode"
              className="input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={form.twoFactorCode}
              onChange={set('twoFactorCode')}
              autoFocus
              required
            />
          </Field>
        )}

        <div className="row-between" style={{ margin: '4px 0 18px' }}>
          <label className="checkbox">
            <input type="checkbox" checked={form.rememberMe} onChange={set('rememberMe')} />
            <span>Keep me signed in</span>
          </label>
          <Link to="/forgot-password">Forgot password?</Link>
        </div>

        <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
          {busy ? <Spinner /> : needsCode ? 'Verify and sign in' : 'Sign in'}
        </button>
      </form>

      <p className="small muted" style={{ marginTop: 18 }}>
        Need an account? <Link to="/register">Create your company workspace</Link>
      </p>
    </>
  );
}
