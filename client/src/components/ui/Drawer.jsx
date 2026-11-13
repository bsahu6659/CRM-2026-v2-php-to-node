import { useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../Icon.jsx';
import { useOverlayBehavior } from './overlayBehavior.js';

/**
 * Right-hand slide-over panel, rendered into <body>. Port of ui.js `drawer()`.
 *
 * Open while rendered; `onClose` fires for the close button, Escape and a
 * click on the backdrop, and the parent unmounts it there. `wide` gives the
 * 760px variant used by the larger forms.
 */
export default function Drawer({ open = true, ...props }) {
  if (!open) return null;
  return <DrawerSurface {...props} />;
}

function DrawerSurface({ title, subtitle, footer, wide = false, onClose, children }) {
  const panelRef = useRef(null);
  useOverlayBehavior(panelRef, () => onClose?.());

  return createPortal(
    <>
      <div className="drawer-overlay" onClick={() => onClose?.()} />
      <aside
        ref={panelRef}
        className={wide ? 'drawer wide' : 'drawer'}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' && title ? title : 'Panel'}
      >
        <div className="drawer-head">
          <div>
            <h3>{title || ''}</h3>
            {subtitle ? <div className="sub muted small">{subtitle}</div> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => onClose?.()}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </>,
    document.body
  );
}
