import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { dateTime, number, relative, titleCase } from '../lib/format.js';
import { emitDataChanged } from '../lib/events.js';
import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/shared.jsx';
import { EmptyState, PageLoader, Pagination, reportError, toast } from '../components/ui/index.js';

/**
 * Full notification centre. Port of the PHP edition's `views/notifications.js`.
 *
 * Notifications are always personal (the server pins every query to the
 * signed-in user), so there is no permission gate here - everyone has a
 * notification centre.
 */
const SEVERITY_COLOR = {
  SUCCESS: 'var(--success)',
  WARNING: 'var(--warning)',
  DANGER: 'var(--danger)',
};

export default function Notifications() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [res, setRes] = useState(null); // null = loading
  const [error, setError] = useState(null);
  // Bumped by every load so a slow response for an older page or filter
  // cannot overwrite the one the user is now looking at.
  const token = useRef(0);

  const load = useCallback(async () => {
    const mine = ++token.current;
    setRes(null);
    setError(null);
    try {
      const next = await api.get('/api/notifications', {
        page,
        limit: 30,
        ...(unreadOnly ? { unread: 'true' } : {}),
      });
      if (mine === token.current) setRes(next);
    } catch (err) {
      if (mine !== token.current) return;
      reportError(err);
      setError(err);
    }
  }, [page, unreadOnly]);

  useEffect(() => {
    load();
    return () => {
      token.current += 1;
    };
  }, [load]);

  async function markAllRead() {
    try {
      const r = await api.post('/api/notifications/read-all');
      toast.success(`${r.data.updated} marked as read`);
      load();
      emitDataChanged();
    } catch (err) {
      reportError(err);
    }
  }

  async function openNotification(n) {
    if (!n.isRead) {
      await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
      emitDataChanged();
    }
    // Links are stored by the server in the hash-router form ('#/leads/42').
    if (n.link) navigate(String(n.link).replace(/^#/, ''));
    else load();
  }

  async function dismiss(e, n) {
    e.stopPropagation();
    try {
      await api.del(`/api/notifications/${n.id}`);
      load();
      emitDataChanged();
    } catch (err) {
      reportError(err);
    }
  }

  const actions = [
    <button
      key="unread"
      type="button"
      className="btn"
      onClick={() => {
        setUnreadOnly((v) => !v);
        setPage(1);
      }}
    >
      <Icon name="filter" size={15} />
      Unread only
    </button>,
    <button key="read-all" type="button" className="btn btn-primary" onClick={markAllRead}>
      <Icon name="check" size={15} />
      Mark all read
    </button>,
  ];

  let body;
  if (error) {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load notifications" message={error.message} />
      </div>
    );
  } else if (!res) {
    body = <PageLoader />;
  } else if (!res.data.length) {
    body = (
      <div className="card">
        <EmptyState
          iconName="bell"
          title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          message="Assignments, due tasks and deal outcomes will show up here."
        />
      </div>
    );
  } else {
    body = (
      <div className="card">
        <div className="card-head">
          <h3>{unreadOnly ? 'Unread' : 'All notifications'}</h3>
          <span className="muted small">{`${number(res.meta.unread)} unread`}</span>
        </div>
        <div>
          {res.data.map((n) => (
            <div
              key={n.id}
              className={`notif-item ${n.isRead ? '' : 'unread'}`}
              onClick={() => openNotification(n)}
            >
              <span
                className="n-dot"
                style={{ background: SEVERITY_COLOR[n.severity] || 'var(--brand-500)', opacity: n.isRead ? '.35' : '1' }}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="n-title">{n.title}</div>
                {n.body ? <div className="n-body">{n.body}</div> : null}
                <div className="n-time" title={dateTime(n.createdAt)}>
                  {`${titleCase(n.type)} · ${relative(n.createdAt)}`}
                </div>
              </div>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={(e) => dismiss(e, n)}>
                <Icon name="close" size={15} />
              </button>
            </div>
          ))}
        </div>
        {res.meta.totalPages > 1 ? <Pagination meta={res.meta} onPage={setPage} /> : null}
      </div>
    );
  }

  return (
    <div>
      <PageHead
        title="Notifications"
        subtitle="Assignments, due follow-ups, deal outcomes and system alerts."
        actions={actions}
      />
      {body}
    </div>
  );
}
