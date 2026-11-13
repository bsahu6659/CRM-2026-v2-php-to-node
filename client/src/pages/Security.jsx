import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import Alert from '../components/Alert.jsx';
import Field from '../components/Field.jsx';
import Icon from '../components/Icon.jsx';
import { Spinner } from '../components/Spinner.jsx';

/**
 * Password, two-factor and email verification — everything that changes how
 * this account authenticates. Each action is a real call; the server revokes
 * other sessions on a password change and requires the current password before
 * turning two-factor off, so both of those are reported back to the user.
 */
export default function Security() {
  const { user, refresh, signOut } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');

  const [setup, setSetup] = useState(null); // { secret, otpauthUri }
  const [code, setCode] = useState('');
  const [twoBusy, setTwoBusy] = useState(false);
  const [twoError, setTwoError] = useState('');

  const [disablePassword, setDisablePassword] = useState('');
  const [disabling, setDisabling] = useState(false);

  const [verifyUrl, setVerifyUrl] = useState('');

  const setPwField = (key) => (e) => setPw((f) => ({ ...f, [key]: e.target.value }));

  async function changePassword(e) {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) {
      setPwError('The two new passwords do not match.');
      return;
    }
    setPwBusy(true);
    setPwError('');
    try {
      const res = await api.post('/api/auth/change-password', {
        currentPassword: pw.currentPassword,
        newPassword: pw.newPassword,
      });
      toast.success('Password updated', res.data.message);
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err) {
      setPwError(err.message);
    } finally {
      setPwBusy(false);
    }
  }

  async function startTwoFactor() {
    setTwoBusy(true);
    setTwoError('');
    try {
      const res = await api.post('/api/auth/2fa/setup');
      setSetup(res.data);
    } catch (err) {
      setTwoError(err.message);
    } finally {
      setTwoBusy(false);
    }
  }

  async function enableTwoFactor(e) {
    e.preventDefault();
    setTwoBusy(true);
    setTwoError('');
    try {
      await api.post('/api/auth/2fa/enable', { code: code.trim() });
      setSetup(null);
      setCode('');
      await refresh();
      toast.success('Two-factor authentication enabled');
    } catch (err) {
      setTwoError(err.message);
    } finally {
      setTwoBusy(false);
    }
  }

  async function disableTwoFactor(e) {
    e.preventDefault();
    setDisabling(true);
    setTwoError('');
    try {
      await api.post('/api/auth/2fa/disable', { password: disablePassword });
      setDisablePassword('');
      await refresh();
      toast.success('Two-factor authentication turned off');
    } catch (err) {
      setTwoError(err.message);
    } finally {
      setDisabling(false);
    }
  }

  async function sendVerification() {
    try {
      const res = await api.post('/api/auth/send-verification');
      // Outside production the server returns the link, because a development
      // install usually has no SMTP server to deliver it.
      if (res.data.verifyUrl) setVerifyUrl(res.data.verifyUrl);
      toast.success('Verification email queued', res.data.message);
    } catch (err) {
      toast.error('Could not send verification', err.message);
    }
  }

  async function signOutEverywhere() {
    try {
      const res = await api.post('/api/auth/logout-all');
      toast.success('Signed out everywhere', `${res.data.sessionsRevoked} session(s) revoked.`);
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error('Could not sign out everywhere', err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Security</h1>
          <div className="sub">Password, two-factor authentication and email verification.</div>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h3>Change password</h3>
        </div>
        <div className="card-body">
          {pwError && (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="danger">{pwError}</Alert>
            </div>
          )}
          <form onSubmit={changePassword} noValidate style={{ maxWidth: 420 }}>
            <Field label="Current password" htmlFor="currentPassword" required>
              <input
                id="currentPassword"
                className="input"
                type="password"
                autoComplete="current-password"
                value={pw.currentPassword}
                onChange={setPwField('currentPassword')}
                required
              />
            </Field>
            <Field
              label="New password"
              htmlFor="newPassword"
              hint="At least 10 characters, with upper and lower case and a digit."
              required
            >
              <input
                id="newPassword"
                className="input"
                type="password"
                autoComplete="new-password"
                value={pw.newPassword}
                onChange={setPwField('newPassword')}
                required
              />
            </Field>
            <Field label="Confirm new password" htmlFor="confirmPassword" required>
              <input
                id="confirmPassword"
                className="input"
                type="password"
                autoComplete="new-password"
                value={pw.confirm}
                onChange={setPwField('confirm')}
                required
              />
            </Field>
            <button className="btn btn-primary" type="submit" disabled={pwBusy}>
              {pwBusy ? <Spinner /> : 'Update password'}
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              Your other sessions are signed out when the password changes.
            </p>
          </form>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h3>Two-factor authentication</h3>
          {user?.twoFactorEnabled && <span className="badge badge-success">On</span>}
        </div>
        <div className="card-body">
          {twoError && (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="danger">{twoError}</Alert>
            </div>
          )}

          {user?.twoFactorEnabled ? (
            <>
              <div style={{ marginBottom: 14 }}>
                <Alert tone="success">
                  Two-factor authentication is on. You will be asked for a code at every sign-in.
                </Alert>
              </div>
              <form onSubmit={disableTwoFactor} noValidate style={{ maxWidth: 420 }}>
                <Field label="Confirm your password to turn it off" htmlFor="disablePassword" required>
                  <input
                    id="disablePassword"
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    required
                  />
                </Field>
                <button className="btn btn-danger" type="submit" disabled={disabling}>
                  {disabling ? <Spinner /> : 'Turn off two-factor'}
                </button>
              </form>
            </>
          ) : setup ? (
            <form onSubmit={enableTwoFactor} noValidate style={{ maxWidth: 520 }}>
              <div className="field">
                <label>Setup key</label>
                <code className="code-block" style={{ wordBreak: 'break-all' }}>
                  {setup.secret}
                </code>
                <span className="hint">Type this into your authenticator app if it cannot scan.</span>
              </div>
              <div className="field">
                <label>Or paste this URI into your app</label>
                <code className="code-block" style={{ wordBreak: 'break-all', fontSize: 11 }}>
                  {setup.otpauthUri}
                </code>
              </div>
              <Field
                label="Verification code"
                htmlFor="totp"
                hint="Enter the current six-digit code."
                required
              >
                <input
                  id="totp"
                  className="input mono"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </Field>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary" type="submit" disabled={twoBusy}>
                  {twoBusy ? <Spinner /> : 'Enable'}
                </button>
                <button className="btn" type="button" onClick={() => setSetup(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="muted" style={{ marginBottom: 14 }}>
                Add a second step at sign-in using any authenticator app (Google Authenticator, Authy, 1Password).
              </p>
              <button className="btn btn-primary" type="button" onClick={startTwoFactor} disabled={twoBusy}>
                {twoBusy ? <Spinner /> : <Icon name="shield" size={15} className="" />}
                Set up two-factor
              </button>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Email and sessions</h3>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn" type="button" onClick={sendVerification}>
              <Icon name="mail" size={15} className="" />
              Resend verification email
            </button>
            <button className="btn btn-danger" type="button" onClick={signOutEverywhere}>
              <Icon name="logout" size={15} className="" />
              Sign out on every device
            </button>
          </div>
          {verifyUrl && (
            <div style={{ marginTop: 14 }}>
              <Alert tone="warning" title="Development mode">
                No mail server is configured, so the link is shown here instead:
                <br />
                <code className="code-inline" style={{ wordBreak: 'break-all' }}>
                  {verifyUrl}
                </code>
              </Alert>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
