import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api.js';
import { relative } from '../../lib/format.js';
import { refreshUnread, setUnreadCount } from '../../lib/unread.js';
import { reportError } from '../../context/ToastContext.jsx';
import { EmptyState } from '../ui/Blocks.jsx';

/**
 * The bell's dropdown: the twelve latest notifications, "Mark all read" and
 * "View all". Port of `notificationPanel()` in the PHP edition's app.js.
 * Rendered as the content of the bell's Dropdown; `close` closes that menu.
 */
const SEVERITY_COLOR = { SUCCESS: 'var(--success)', WARNING: 'var(--warning)', DANGER: 'var(--danger)' };

export default function NotificationPanel({ close }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', rows: [], error: null });

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications', { limit: 12 });
      setState({ status: 'ready', rows: res.data || [], error: null });
    } catch (err) {
      setState({ status: 'error', rows: [], error: err });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function markAllRead() {
    try {
      await api.post('/api/notifications/read-all');
      setUnreadCount(0);
      refreshUnread();
      load();
    } catch (err) {
      reportError(err);
    }
  }

  async function open(n) {
    if (!n.isRead) {
      await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
      refreshUnread();
    }
    close();
    if (n.link) navigate(String(n.link).replace(/^#/, ''));
  }

  let list;
  if (state.status === 'loading') {
    list = (
      <div className="page-loader">
        <span className="spinner" />
      </div>
    );
  } else if (state.status === 'error') {
    list = <EmptyState iconName="alert" title="Could not load notifications" message={state.error?.message} />;
  } else if (!state.rows.length) {
    list = <EmptyState iconName="bell" title="All caught up" message="Nothing needs your attention right now." />;
  } else {
    list = state.rows.map((n) => (
      <div key={n.id} className={n.isRead ? 'notif-item' : 'notif-item unread'} onClick={() => open(n)}>
        <span
          className="n-dot"
          style={{ background: SEVERITY_COLOR[n.severity] || 'var(--brand-500)', opacity: n.isRead ? '.3' : '1' }}
        />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="n-title">{n.title}</div>
          {n.body ? <div className="n-body">{n.body}</div> : null}
          <div className="n-time">{relative(n.createdAt)}</div>
        </div>
      </div>
    ));
  }

  return (
    <div className="notif-panel">
      <div className="row-between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-2)' }}>
        <strong>Notifications</strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={markAllRead}>
          Mark all read
        </button>
      </div>
      <div style={{ overflowY: 'auto', flex: '1' }}>{list}</div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line-2)' }}>
        <button
          type="button"
          className="btn btn-sm btn-block"
          onClick={() => {
            close();
            navigate('/notifications');
          }}
        >
          View all
        </button>
      </div>
    </div>
  );
}
