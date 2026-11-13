import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api.js';
import Icon from '../Icon.jsx';
import { EmptyState } from '../ui/Blocks.jsx';
import { lockBodyScroll } from '../ui/overlayBehavior.js';

/**
 * Command palette: jump to a page, or search leads, projects and people
 * through /api/search. Port of `openPalette()` in the PHP edition's app.js -
 * opened by the topbar search button, Cmd/Ctrl+K, or a bare "/".
 */
const TYPE_ICON = { lead: 'leads', project: 'building', user: 'users' };

export default function CommandPalette({ navTargets, onClose }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const timer = useRef(null);
  const searchToken = useRef(0);
  const scrollActive = useRef(false);

  const [view, setView] = useState(() => ({ kind: 'groups', groups: navigationGroups('') }));
  const [active, setActive] = useState(-1);

  function go(path) {
    onClose();
    navigate(path);
  }

  function navigationGroups(term) {
    const matches = navTargets.filter((i) => i.label.toLowerCase().includes(term.toLowerCase()));
    if (!matches.length) return [];
    return [
      {
        title: 'Go to',
        items: matches.slice(0, 6).map((item) => ({
          key: `nav:${item.path}`,
          kind: 'page',
          iconName: item.iconName,
          title: item.label,
          path: item.path,
        })),
      },
    ];
  }

  function runSearch(term) {
    const token = ++searchToken.current;
    if (term.length < 2) {
      setView({ kind: 'groups', groups: navigationGroups('') });
      setActive(-1);
      return;
    }
    api
      .get('/api/search', { q: term, limit: 6 })
      .then((res) => {
        if (token !== searchToken.current) return; // a newer keystroke won
        const grouped = new Map();
        for (const item of res.data.results) {
          if (!grouped.has(item.type)) grouped.set(item.type, []);
          grouped.get(item.type).push(item);
        }
        const groups = [...navigationGroups(term)];
        for (const [type, items] of grouped) {
          groups.push({
            title: `${type}s`,
            items: items.map((item, i) => ({
              key: `${type}:${item.id ?? i}`,
              kind: 'result',
              iconName: TYPE_ICON[type] || 'file',
              title: item.title,
              subtitle: item.subtitle,
              badge: item.badge,
              badgeColor: item.badgeColor,
              path: String(item.link || '').replace(/^#/, ''),
            })),
          });
        }
        if (!groups.length) {
          setView({ kind: 'empty', term });
          setActive(-1);
          return;
        }
        setView({ kind: 'groups', groups });
        setActive(0);
      })
      .catch((err) => {
        if (token !== searchToken.current) return;
        setView({ kind: 'error', message: err.message });
        setActive(-1);
      });
  }

  const flat = view.kind === 'groups' ? view.groups.flatMap((g) => g.items) : [];
  const latest = useRef({ flat, active });
  latest.current = { flat, active };

  useEffect(() => {
    inputRef.current?.focus();
    const unlock = lockBodyScroll();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Only the palette closes, not a dialog it may have been opened over.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const { flat: items, active: current } = latest.current;
        if (!items.length) return;
        const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
        scrollActive.current = true;
        setActive(next);
      }
      if (e.key === 'Enter') {
        const { flat: items, active: current } = latest.current;
        const target = items[current] || items[0];
        if (target) go(target.path);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.clearTimeout(timer.current);
      unlock();
    };
    // Mounted once per opening; `go` and `onClose` only close and navigate.
  }, []);

  useEffect(() => {
    if (!scrollActive.current) return;
    scrollActive.current = false;
    resultsRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let index = -1;
  const renderItem = (item) => {
    index += 1;
    const itemIndex = index;
    const className = itemIndex === active ? 'palette-item active' : 'palette-item';
    if (item.kind === 'page') {
      return (
        <div key={item.key} className={className} onClick={() => go(item.path)}>
          <Icon name={item.iconName} size={16} />
          <div>
            <div className="p-title">{item.title}</div>
          </div>
          <span className="badge p-type">Page</span>
        </div>
      );
    }
    return (
      <div key={item.key} className={className} onClick={() => go(item.path)}>
        <Icon name={item.iconName} size={16} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="p-title truncate">{item.title}</div>
          {item.subtitle ? <div className="p-sub truncate">{item.subtitle}</div> : null}
        </div>
        {item.badge ? (
          <span
            className="badge p-type"
            style={item.badgeColor ? { background: `${item.badgeColor}1f`, color: item.badgeColor } : undefined}
          >
            {item.badge}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="overlay palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette-box">
        <div className="palette-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search leads, projects and people…  or jump to a page"
            aria-label="Search"
            onChange={(e) => {
              const term = e.target.value.trim();
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => runSearch(term), 220);
            }}
          />
          <kbd style={{ fontSize: '11px', color: 'var(--ink-4)' }}>Esc</kbd>
        </div>
        <div className="palette-results" ref={resultsRef}>
          {view.kind === 'groups' ? (
            view.groups.length ? (
              view.groups.map((group) => (
                <div key={group.title}>
                  <div className="palette-group-title">{group.title}</div>
                  {group.items.map(renderItem)}
                </div>
              ))
            ) : (
              <div />
            )
          ) : null}
          {view.kind === 'empty' ? (
            <EmptyState title="No matches" message={`Nothing found for “${view.term}”.`} />
          ) : null}
          {view.kind === 'error' ? <EmptyState iconName="alert" title="Search failed" message={view.message} /> : null}
        </div>
      </div>
    </div>
  );
}
