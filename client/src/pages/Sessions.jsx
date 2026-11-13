import { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { dateTime, relative } from '../lib/format.js';
import Alert from '../components/Alert.jsx';
import Icon from '../components/Icon.jsx';
import { PageLoader, Spinner } from '../components/Spinner.jsx';

/**
 * Every live session for this account.
 *
 * Sessions are rows in the database, not self-contained tokens, so revoking
 * one takes effect on that device's very next request — there is no window
 * where a signed-out device still works because its token has not expired.
 */
export default function Sessions() {
  const toast = useToast();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/auth/sessions');
      setSessions(res.data);
      setError('');
    } catch (err) {
      setError(err.message);
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id) {
    setRevoking(id);
    try {
      await api.del(`/api/auth/sessions/${id}`);
      toast.success('Session revoked', 'That device will be signed out on its next request.');
      await load();
    } catch (err) {
      toast.error('Could not revoke session', err.message);
    } finally {
      setRevoking(null);
    }
  }

  if (sessions === null) return <PageLoader label="Loading sessions…" />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Active sessions</h1>
          <div className="sub">Devices and browsers currently signed in to this account.</div>
        </div>
        <button className="btn" type="button" onClick={load}>
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <section className="card">
        <div className="card-body" style={{ padding: 0 }}>
          {sessions.length === 0 ? (
            <div className="empty">
              <div className="e-icon">
                <Icon name="monitor" size={22} className="" />
              </div>
              <h3>No active sessions</h3>
              <p>Nothing is signed in right now.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>IP address</th>
                    <th>Signed in</th>
                    <th>Last seen</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <Icon name="monitor" size={15} className="" />
                          <span className="truncate" style={{ maxWidth: 320 }} title={s.userAgent || ''}>
                            {s.userAgent || 'Unknown device'}
                          </span>
                          {s.current && <span className="badge badge-success">This device</span>}
                          {s.rememberMe && <span className="badge">Remembered</span>}
                        </div>
                      </td>
                      <td className="mono tiny nowrap">{s.ip || '—'}</td>
                      <td className="nowrap">{dateTime(s.createdAt)}</td>
                      <td className="nowrap">{relative(s.lastSeenAt)}</td>
                      <td className="nowrap">{dateTime(s.expiresAt)}</td>
                      <td className="right nowrap">
                        <button
                          className="btn btn-sm btn-danger"
                          type="button"
                          onClick={() => revoke(s.id)}
                          disabled={revoking === s.id}
                        >
                          {revoking === s.id ? <Spinner /> : s.current ? 'Sign out here' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
