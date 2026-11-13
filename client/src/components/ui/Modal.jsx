import { useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../Icon.jsx';
import { useOverlayBehavior } from './overlayBehavior.js';

/**
 * Centred dialog, rendered into <body>. Port of ui.js `modal()`.
 *
 * It is open while it is rendered: the parent mounts it, and unmounts it in
 * `onClose`, which fires for the close button, Escape and (unless
 * `closeOnBackdrop` is false) a press on the backdrop.
 *
 *   {editing && (
 *     <Modal title="Edit stage" onClose={() => setEditing(null)}
 *            footer={<div className="row"><button className="btn" onClick={…}>Cancel</button>…</div>}>
 *       …body…
 *     </Modal>
 *   )}
 */
export default function Modal({ open = true, ...props }) {
  if (!open) return null;
  return <ModalSurface {...props} />;
}

function ModalSurface({ title, subtitle, footer, size = '', onClose, closeOnBackdrop = true, children }) {
  const boxRef = useRef(null);
  useOverlayBehavior(boxRef, () => onClose?.());

  return createPortal(
    <div
      className="overlay"
      onMouseDown={
        closeOnBackdrop
          ? (e) => {
              if (e.target === e.currentTarget) onClose?.();
            }
          : undefined
      }
    >
      <div
        ref={boxRef}
        className={['modal', size].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' && title ? title : 'Dialog'}
      >
        <div className="modal-head">
          <div>
            <h3>{title || ''}</h3>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => onClose?.()}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}
