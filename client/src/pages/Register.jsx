import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import Alert from '../components/Alert.jsx';
import Field from '../components/Field.jsx';
import { Spinner } from '../components/Spinner.jsx';

/**
 * Self-service signup. One POST provisions a whole tenant — roles, statuses,
 * sources, scoring rules, templates — and signs the founder in, so there is no
 * second step to land on.
 */
export default function Register() {
  const { status, refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    organizationName: '',
    firstName: '',
    lastName: '',
    email: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  if (status === 'signed-in') return <Navigate to="/" replace />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await api.post('/api/auth/register', {
        organizationName: form.organizationName.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Create your workspace</h1>
      <p className="sub">You become the Super Admin of a new, private company workspace.</p>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <Field label="Company name" htmlFor="organizationName" error={fieldErrors.organizationName} required>
          <input
            id="organizationName"
            className="input"
            value={form.organizationName}
            onChange={set('organizationName')}
            maxLength={120}
            required
          />
        </Field>

        <div className="form-grid">
          <Field label="First name" htmlFor="firstName" error={fieldErrors.firstName} required>
            <input
              id="firstName"
              className="input"
              autoComplete="given-name"
              value={form.firstName}
              onChange={set('firstName')}
              maxLength={60}
              required
            />
          </Field>
          <Field label="Last name" htmlFor="lastName" error={fieldErrors.lastName}>
            <input
              id="lastName"
              className="input"
              autoComplete="family-name"
              value={form.lastName}
              onChange={set('lastName')}
              maxLength={60}
            />
          </Field>
        </div>

        <Field label="Work email" htmlFor="email" error={fieldErrors.email} required>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            value={form.email}
            onChange={set('email')}
            required
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={fieldErrors.password}
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

        <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
          {busy ? <Spinner /> : 'Create workspace'}
        </button>
      </form>

      <p className="small muted" style={{ marginTop: 18 }}>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </>
  );
}
