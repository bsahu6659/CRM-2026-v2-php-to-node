import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import Icon from '../Icon.jsx';

/**
 * Anchored dropdown that closes on outside click, Escape or navigation.
 * Port of ui.js `dropdown()` / `menuItem()`.
 *
 * The menu opens downward by default, but a trigger near the bottom of the
 * window - the sidebar profile card, the action button on the last row of a
 * table - would push it off-screen, which reads as "the menu did not open".
 * `place()` measures the real gap and flips the menu above the trigger, or
 * nudges it back inside the horizontal edges, whenever it needs to.
 *
 * The menu is portalled to <body>, not rendered inside the trigger's wrapper:
 * an absolutely positioned menu is clipped by any scrolling ancestor, and
 * `.table-wrap` is one - its overflow-y computes to `auto` because overflow-x
 * is `auto`.
 */
const DropdownContext = createContext(null);

const GAP = 6;
const EDGE = 8;
const MIN_MENU_H = 120;

export function Dropdown({ trigger, align = 'right', children }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  // A body-mounted menu would outlive a route change otherwise.
  const { pathname, search } = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [pathname, search]);

  const place = useCallback(() => {
    const menu = menuRef.current;
    const anchorEl = wrapRef.current?.firstElementChild || wrapRef.current;
    if (!menu) return;
    // The trigger can disappear underneath an open menu when its list re-renders.
    if (!anchorEl || !anchorEl.isConnected) {
      setOpen(false);
      return;
    }

    const anchor = anchorEl.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const viewportW = window.innerWidth || document.documentElement.clientWidth;
    if (!viewportH || !viewportW) return; // hidden pane: nothing meaningful to measure

    // Measure the menu's natural height with no cap imposed, so a previous
    // placement's max-height cannot skew this one.
    menu.style.maxHeight = '';
    const naturalH = menu.offsetHeight;
    const menuW = menu.offsetWidth;

    const roomBelow = viewportH - anchor.bottom - GAP - EDGE;
    const roomAbove = anchor.top - GAP - EDGE;

    // Flip above the trigger when it does not fit below and there is more room up there.
    const flipUp = naturalH > roomBelow && roomAbove > roomBelow;
    const available = Math.max(MIN_MENU_H, flipUp ? roomAbove : roomBelow);
    const menuH = Math.min(naturalH, available);
    // Capping the height means a menu taller than the screen scrolls internally
    // instead of hanging off the edge.
    menu.style.maxHeight = `${Math.round(available)}px`;

    let top = flipUp ? anchor.top - menuH - GAP : anchor.bottom + GAP;
    top = Math.max(EDGE, Math.min(top, viewportH - menuH - EDGE));

    let left = align === 'left' ? anchor.left : anchor.right - menuW;
    left = Math.max(EDGE, Math.min(left, viewportW - menuW - EDGE));

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    // Re-place once the browser has settled: icons and web fonts can change the
    // menu's height after the first measurement.
    const frame = requestAnimationFrame(place);

    // The menu lives on <body>, so "outside" has to consider it as well as the wrapper.
    const onOutside = (e) => {
      if (!wrapRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Only the menu closes - not the modal or drawer it may be sitting in.
      e.stopPropagation();
      setOpen(false);
    };

    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  const onTriggerClick = (e) => {
    // Keeps a click on the trigger from also counting as a row click, a card
    // click or anything else listening further up.
    e.stopPropagation();
    setOpen((value) => !value);
  };

  return (
    <DropdownContext.Provider value={close}>
      <div className="dropdown" ref={wrapRef} onClick={onTriggerClick}>
        {trigger}
      </div>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={align === 'left' ? 'dropdown-menu left' : 'dropdown-menu'}
              // React bubbles events out of a portal along the component tree,
              // so without this a menu click inside a table row would also be
              // a click on the row.
              onClick={(e) => e.stopPropagation()}
            >
              {typeof children === 'function' ? children(close) : children}
            </div>,
            document.body
          )
        : null}
    </DropdownContext.Provider>
  );
}

/**
 * Menu entry. Closes the surrounding Dropdown, then runs `onClick`.
 * `close` overrides the Dropdown's own close (rarely needed).
 */
export function MenuItem({ iconName, onClick, danger = false, close, disabled, children }) {
  const dropdownClose = useContext(DropdownContext);
  return (
    <button
      type="button"
      className={danger ? 'dropdown-item danger' : 'dropdown-item'}
      disabled={disabled}
      onClick={() => {
        (close || dropdownClose)?.();
        onClick?.();
      }}
    >
      {iconName ? <Icon name={iconName} size={15} /> : null}
      {children}
    </button>
  );
}

/** `div.dropdown-sep` - the thin rule between groups of items. */
export function MenuSeparator() {
  return <div className="dropdown-sep" />;
}

/** `div.dropdown-title` - the small uppercase heading at the top of a menu. */
export function MenuTitle({ children }) {
  return <div className="dropdown-title">{children}</div>;
}

/** The enclosing Dropdown's `close()`, for custom menu content. `null` outside a Dropdown. */
export function useDropdownClose() {
  return useContext(DropdownContext);
}
