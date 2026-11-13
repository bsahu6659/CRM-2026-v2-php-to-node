import { useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { openOverlay, useOverlay } from './OverlayHost.jsx';

/**
 * Promise-based confirm. Destructive actions must await this.
 * Port of ui.js `confirmDialog()`: same markup, labels and the optional
 * "type the name to confirm" guard.
 */
export function ConfirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  requireText = null,
  onResolve,
}) {
  const [typed, setTyped] = useState('');
  const settled = useRef(false);
  const finish = (value) => {
    if (settled.current) return;
    settled.current = true;
    onResolve?.(value);
  };

  return (
    <Modal
      title={title}
      onClose={() => finish(false)}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={() => finish(false)}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={Boolean(requireText) && typed.trim() !== requireText}
            onClick={() => finish(true)}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div>
        {message ? <p className="muted">{message}</p> : null}
        {requireText ? (
          <div className="field mt-16">
            <label>{`Type “${requireText}” to confirm`}</label>
            <input
              className="input"
              placeholder={requireText}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * `confirmDialog({ title, message, confirmLabel, cancelLabel, danger, requireText })`
 * → Promise<boolean>. Resolves `true` only for the confirm button; Cancel,
 * the close button, Escape and the backdrop all resolve `false`.
 * Usable from plain helper functions as well as components.
 */
export function confirmDialog(options = {}) {
  return new Promise((resolve) => {
    openOverlay((closeOverlay) => (
      <ConfirmDialog
        {...options}
        onResolve={(value) => {
          closeOverlay();
          resolve(value);
        }}
      />
    ));
  });
}

/** Hook: returns `confirm(options) => Promise<boolean>` (the same as `confirmDialog`). */
export function useConfirm() {
  useOverlay(); // asserts the provider is mounted
  return confirmDialog;
}
