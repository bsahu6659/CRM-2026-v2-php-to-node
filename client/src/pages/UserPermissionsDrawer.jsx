/**
 * Per-user special access (spec sections 11 and 12). Port of the PHP
 * edition's `views/userPermissions.js`.
 *
 * Roles decide what a job title can do. This drawer handles the exceptions
 * every real sales floor has: the executive covering for a manager on leave who
 * needs export for a fortnight, or the rep whose lead creation is paused during
 * a data-quality review.
 *
 * Each row shows the three values the spec asks for side by side -
 *
 *     inherited from the role  +  special override  =  effective
 *
 * - so the person granting access can see exactly what they are changing and
 * what it was before.
 *
 * Used by Users.jsx and Roles.jsx, always through `openOverlay` so the drawer
 * outlives the menu or table row that opened it:
 *
 *   openOverlay((close) => <PermissionsDrawer user={row} onClose={close} onSaved={refresh} />);
 */
import { useEffect, useMemo, useState } from 'react';
import api from '../lib/api.js';
import { titleCase } from '../lib/format.js';
import { Drawer, Input, PageLoader, Select, reportError, toast } from '../components/ui/index.js';

const EFFECT_NONE = '';

export function PermissionsDrawer({ user, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Working copy of the override set, keyed "module:action".
  const [overrides, setOverrides] = useState(() => new Map());
  // What each row's scope picker shows. Kept apart from `overrides` because
  // the original's picker kept its value while disabled, so switching a row
  // to Revoke and back to Grant restored the scope that had been chosen.
  const [scopePicks, setScopePicks] = useState(() => new Map());
  const [reason, setReason] = useState('');
  // Save stays disabled until something actually changes, as before.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .data(`/api/users/${user.id}/permissions`, undefined, { signal: ctrl.signal })
      .then((res) => {
        const initial = new Map();
        const picks = new Map();
        for (const s of res.special || []) {
          const key = `${s.module}:${s.action}`;
          initial.set(key, { effect: s.effect, dataScope: s.dataScope || '', reason: s.reason || '' });
          picks.set(key, s.dataScope || '');
        }
        setOverrides(initial);
        setScopePicks(picks);
        setReason((res.special || [])[0]?.reason || '');
        setData(res);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setLoadError(err);
      });
    return () => ctrl.abort();
  }, [user.id]);

  const groups = useMemo(() => {
    const out = {};
    for (const mod of data?.catalogue || []) {
      (out[mod.group] ||= []).push(mod);
    }
    return out;
  }, [data]);

  const scopeOptions = useMemo(
    () => [{ value: '', label: 'Same as role' }, ...(data?.dataScopes || []).map((s) => ({ value: s.key, label: s.label }))],
    [data]
  );

  /** The original's `repaint()`: record the row's override from its two pickers. */
  const applyRow = (key, effect, scope) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      if (effect === EFFECT_NONE) next.delete(key);
      else next.set(key, { effect, dataScope: scope || '', reason });
      return next;
    });
    setDirty(true);
  };

  const changeEffect = (key, effect) => applyRow(key, effect, scopePicks.get(key) || '');

  const changeScope = (key, scope) => {
    setScopePicks((prev) => new Map(prev).set(key, scope));
    applyRow(key, overrides.get(key)?.effect || EFFECT_NONE, scope);
  };

  const save = async () => {
    const payload = [...overrides.entries()].map(([key, value]) => {
      const [module, action] = key.split(':');
      return {
        module,
        action,
        effect: value.effect,
        dataScope: value.dataScope || null,
        reason: reason.trim() || value.reason || null,
      };
    });
    setSaving(true);
    try {
      await api.put(`/api/users/${user.id}/permissions`, { permissions: payload });
      toast.success(
        payload.length ? `${payload.length} special permission${payload.length === 1 ? '' : 's'} saved` : 'Special access cleared',
        'It applies the next time they load the app.'
      );
      onClose();
      onSaved?.();
    } catch (err) {
      setSaving(false);
      reportError(err);
    }
  };

  let body;
  if (loadError) {
    body = <div className="alert danger">{loadError.message}</div>;
  } else if (!data) {
    body = <PageLoader label="Loading permissions" />;
  } else {
    const roleScopeLabel = (data.dataScopes.find((s) => s.key === data.role.dataScope) || {}).label?.toLowerCase();
    body = (
      <div>
        <div className="alert info mb-16">
          <strong>{`Role: ${data.role.name}. `}</strong>
          {'Everything below is inherited from that role unless you override it here. '}
          {`Their role sees ${roleScopeLabel || 'their own records'}.`}
        </div>

        <div>
          {Object.entries(groups).map(([groupName, modules]) => {
            // Platform modules are not a tenant's to grant; the server refuses them
            // anyway, so showing them here would only be misleading.
            if (groupName === 'Platform') return null;
            return [
              <h4 key={`h:${groupName}`} className="mt-16 mb-8">
                {groupName}
              </h4>,
              ...modules.map((mod) => (
                <div key={mod.key} className="card mb-16">
                  <div className="card-body">
                    <div className="row-between mb-8">
                      <strong>{mod.label}</strong>
                      <span className="tiny muted">role → override → effective</span>
                    </div>
                    {mod.actions.map((action) => {
                      const key = `${mod.key}:${action}`;
                      const inherited = (data.inherited[mod.key] || []).includes(action);
                      const override = overrides.get(key);
                      const allowed = override ? override.effect === 'GRANT' : inherited;
                      return (
                        <div
                          key={action}
                          className="row"
                          style={{ gap: '10px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)' }}
                        >
                          <div style={{ width: '130px', flexShrink: 0 }}>
                            <span className="small">{titleCase(action)}</span>
                          </div>
                          <div style={{ width: '90px', flexShrink: 0 }}>
                            <span className="tiny muted">{inherited ? 'Role: yes' : 'Role: no'}</span>
                          </div>
                          <div style={{ flex: '1 1 190px' }}>
                            <Select
                              options={[
                                { value: EFFECT_NONE, label: inherited ? 'Inherited (allowed)' : 'Inherited (not allowed)' },
                                { value: 'GRANT', label: 'Grant to this user' },
                                { value: 'REVOKE', label: 'Revoke from this user' },
                              ]}
                              value={override?.effect || EFFECT_NONE}
                              onChange={(e) => changeEffect(key, e.target.value)}
                            />
                          </div>
                          <div style={{ flex: '1 1 170px' }}>
                            <Select
                              options={scopeOptions}
                              value={scopePicks.get(key) || ''}
                              disabled={!override || override.effect !== 'GRANT'}
                              onChange={(e) => changeScope(key, e.target.value)}
                            />
                          </div>
                          <div style={{ width: '100px', flexShrink: 0, textAlign: 'right' }}>
                            <span className={`badge ${allowed ? 'badge-success' : ''}`}>{allowed ? 'Allowed' : 'Not allowed'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )),
            ];
          })}
        </div>

        <div className="field mt-16">
          <label>Reason (recorded in the audit log)</label>
          <Input
            placeholder="Why does this person need the exception?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
    );
  }

  return (
    <Drawer
      title="Special access"
      subtitle={`${user.fullName || user.email} — overrides on top of their role`}
      wide
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!data || !dirty || saving} onClick={save}>
            Save special access
          </button>
        </div>
      }
    >
      {body}
    </Drawer>
  );
}

export default PermissionsDrawer;
