import { useEffect, useRef } from 'react';
import Icon from './Icon.jsx';

/**
 * Inline message box. tone: 'info' | 'success' | 'warning' | 'danger'.
 *
 * A danger alert scrolls itself into view when it appears or its text
 * changes - the PHP edition's `mount()` did this for every `.alert.danger`.
 * A failure message is written to the top of a form, but the reader is at
 * the bottom: they have just scrolled past every field to reach the submit
 * button, which in a drawer stays pinned there. Without this the message is
 * delivered off-screen and the button simply looks broken.
 */
export default function Alert({ tone = 'info', title, className, children }) {
  const ref = useRef(null);
  const text = typeof children === 'string' ? children : '';

  useEffect(() => {
    // Instant, not smooth: a smooth scroll is an animation, and re-rendering
    // the form around it cancels the animation before it arrives.
    if (tone === 'danger') ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [tone, title, text]);

  return (
    <div ref={ref} className={['alert', tone, className].filter(Boolean).join(' ')} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={tone === 'success' ? 'check' : 'alert'} size={16} className="" />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}
