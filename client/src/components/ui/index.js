/**
 * The UI kit - React ports of everything the PHP edition's `js/lib/ui.js`
 * exported. Import from here:
 *
 *   import { DataTable, Drawer, useConfirm, toast } from '../components/ui/index.js';
 *
 * docs/CLIENT-UI.md is the reference for every export.
 */
export { default as Modal } from './Modal.jsx';
export { default as Drawer } from './Drawer.jsx';
export { UIProvider, openOverlay, useOverlay } from './OverlayHost.jsx';
export { ConfirmDialog, confirmDialog, useConfirm } from './Confirm.jsx';
export {
  Avatar,
  StatusBadge,
  EmptyState,
  SkeletonBlock,
  SkeletonTable,
  PageLoader,
  KpiCard,
  ProgressBar,
} from './Blocks.jsx';
export { default as Field } from '../Field.jsx';
export { Input, Textarea, Select, SwitchToggle } from './FormControls.jsx';
export { Dropdown, MenuItem, MenuSeparator, MenuTitle, useDropdownClose } from './Dropdown.jsx';
export { Tabs, Pagination } from './Navigation.jsx';
export { default as DataTable } from './DataTable.jsx';
export { default as SearchBox } from './SearchBox.jsx';
export { BusyButton, useBusy } from './Busy.jsx';
export { copyToClipboard } from './clipboard.js';
export { Spinner } from '../Spinner.jsx';
export { default as Alert } from '../Alert.jsx';
export { toast, reportError, useToast, useReportError } from '../../context/ToastContext.jsx';
