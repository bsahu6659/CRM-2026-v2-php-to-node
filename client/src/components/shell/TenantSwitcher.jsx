import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { exitClientContext, switchToClient } from '../../lib/tenant.js';
import Icon from '../Icon.jsx';
import { Dropdown, MenuItem, MenuSeparator, MenuTitle } from '../ui/Dropdown.jsx';

/**
 * Tenant switcher, platform admins only. Port of `tenantSwitcher()` in the
 * PHP edition's app.js.
 *
 * Being inside somebody else's CRM is exactly the situation where a person
 * forgets which data they are looking at, so when impersonating this is a
 * coloured, always-visible bar rather than a quiet dropdown - and every entry
 * into a client is written to that client's audit log.
 */
export default function TenantSwitcher() {
  const { user, organization, platform } = useAuth();
  const navigate = useNavigate();
  if (!user?.isPlatformAdmin) return null;

  const impersonating = Boolean(user.isImpersonating);
  const clients = platform?.clients || [];

  const trigger = (
    <button
      type="button"
      className="btn btn-sm"
      style={
        impersonating
          ? { background: 'var(--warning)', color: '#0d1b2a', fontWeight: '700', borderColor: 'transparent' }
          : undefined
      }
    >
      <Icon name="building" size={14} />
      <span className="truncate tenant-name">{impersonating ? `Inside: ${organization?.name}` : 'Platform'}</span>
      <Icon name="chevronDown" size={13} />
    </button>
  );

  return (
    <div className="row tenant-switcher" style={{ gap: '6px', marginLeft: '10px' }}>
      <Dropdown trigger={trigger} align="left">
        <div>
          <MenuTitle>Open a client CRM</MenuTitle>
          {clients.length ? (
            clients.slice(0, 40).map((c) => (
              <MenuItem key={c.id} iconName="building" onClick={() => switchToClient(c.id, c.name)}>
                {c.name}
              </MenuItem>
            ))
          ) : (
            <div className="dropdown-item muted">No client companies yet</div>
          )}
          <MenuSeparator />
          <MenuItem iconName="grid" onClick={() => navigate('/clients')}>
            Manage clients
          </MenuItem>
        </div>
      </Dropdown>
      {impersonating ? (
        // The label is dropped on a phone, where the topbar has no room for it;
        // the icon and the title carry the meaning there.
        <button
          type="button"
          className="btn btn-sm exit-client"
          title="Exit to platform"
          aria-label="Exit to platform"
          onClick={() => exitClientContext()}
        >
          <Icon name="logout" size={14} />
          <span className="exit-text">Exit to platform</span>
        </button>
      ) : null}
    </div>
  );
}
