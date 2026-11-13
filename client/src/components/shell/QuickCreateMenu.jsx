import { lazy, Suspense } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { emitDataChanged } from '../../lib/events.js';
import { openOverlay } from '../ui/OverlayHost.jsx';
import { MenuItem, MenuSeparator, MenuTitle } from '../ui/Dropdown.jsx';

/**
 * The Create menu, scoped to what the signed-in role may actually create.
 * Port of `quickCreateMenu()` in the PHP edition's app.js.
 *
 *   Super Admin  New Lead, New User, New Project, New Client Admin
 *   Admin        New Lead, New User, New Project
 *   Everyone     New Lead
 *
 * "New client admin" is platform-only: creating an administrator means
 * creating the company they administer, which is the Super Admin's job alone.
 * The menu mirrors the server's permission checks; it does not replace them.
 *
 * The forms belong to the pages that own the records and are loaded only
 * when chosen (contract in docs/CLIENT-UI.md, "Forms the shell opens"):
 *   pages/LeadForm.jsx   default export  LeadForm({ lead, onSaved, onClose })
 *   pages/Projects.jsx   named export    ProjectForm({ project, onSaved, onClose })
 *   pages/Users.jsx      named export    UserForm({ user, onSaved, onClose })
 *   pages/Clients.jsx    named export    ClientWizard({ onSaved, onClose })
 */
const LeadForm = lazy(() => import('../../pages/LeadForm.jsx'));
const ProjectForm = lazy(() => import('../../pages/Projects.jsx').then((m) => ({ default: m.ProjectForm })));
const UserForm = lazy(() => import('../../pages/Users.jsx').then((m) => ({ default: m.UserForm })));
const ClientWizard = lazy(() => import('../../pages/Clients.jsx').then((m) => ({ default: m.ClientWizard })));

/** Opens a lazily loaded form through the overlay host, so it outlives this menu. */
function openForm(Form, props) {
  openOverlay((close) => (
    <Suspense fallback={null}>
      <Form {...props} onClose={close} />
    </Suspense>
  ));
}

export default function QuickCreateMenu({ onClientCreated }) {
  const { can, user } = useAuth();
  const items = [];

  if (can('leads', 'create')) {
    items.push(
      <MenuItem key="lead" iconName="leads" onClick={() => openForm(LeadForm, { onSaved: emitDataChanged })}>
        New lead
      </MenuItem>
    );
  }
  if (can('projects', 'create')) {
    items.push(
      <MenuItem key="project" iconName="building" onClick={() => openForm(ProjectForm, { onSaved: emitDataChanged })}>
        New project
      </MenuItem>
    );
  }
  if (can('users', 'create')) {
    items.push(
      <MenuItem key="user" iconName="users" onClick={() => openForm(UserForm, { onSaved: emitDataChanged })}>
        New user
      </MenuItem>
    );
  }
  if (user?.isPlatformAdmin) {
    items.push(<MenuSeparator key="sep" />);
    items.push(
      <MenuItem key="client" iconName="shield" onClick={() => openForm(ClientWizard, { onSaved: onClientCreated })}>
        New client admin
      </MenuItem>
    );
  }

  if (!items.length) {
    items.push(
      <div key="none" className="muted small" style={{ padding: '10px' }}>
        Your role has no create permissions.
      </div>
    );
  }

  return (
    <div>
      <MenuTitle>Create</MenuTitle>
      {items}
    </div>
  );
}
