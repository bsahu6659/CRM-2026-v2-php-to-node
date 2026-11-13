import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon.jsx';

/**
 * Debounced search box for table toolbars. Port of ui.js `searchBox()`.
 *
 * `onSearch(term)` fires 320ms after the last keystroke with the trimmed
 * text. `value` is the term currently applied (for example from the URL); it
 * seeds the box and re-seeds it whenever it changes from outside - a "Clear
 * filters" button, a saved view - but typing does not need to feed it back.
 */
export default function SearchBox({ placeholder, onSearch, value = '', delay = 320 }) {
  const [text, setText] = useState(value);
  const timer = useRef(null);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(() => {
    window.clearTimeout(timer.current);
    setText(value ?? '');
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="search-input">
      <Icon name="search" size={15} />
      <input
        className="input"
        type="search"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onSearchRef.current?.(next.trim()), delay);
        }}
      />
    </div>
  );
}
