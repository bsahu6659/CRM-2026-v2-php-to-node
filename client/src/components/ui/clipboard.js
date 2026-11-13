import { toast } from '../../context/ToastContext.jsx';

/** Copies `text` and confirms with a toast. Port of ui.js `copyToClipboard()`. */
export function copyToClipboard(text, label = 'Copied to clipboard') {
  const write = navigator.clipboard?.writeText(text);
  if (!write) {
    toast.error('Could not copy', 'Your browser blocked clipboard access.');
    return;
  }
  write
    .then(() => toast.success(label))
    .catch(() => toast.error('Could not copy', 'Your browser blocked clipboard access.'));
}
