/**
 * Form controls - ports of ui.js `input()`, `textarea()`, `select()` and
 * `switchToggle()`. Each is the plain element with the stylesheet's class
 * applied; every other prop (value, onChange, name, placeholder, disabled…)
 * passes straight through, and refs reach the DOM element.
 */
import { forwardRef } from 'react';

const cx = (...parts) => parts.filter(Boolean).join(' ');

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx('input', className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx('textarea', className)} {...props} />;
});

/**
 * `options`: an array of plain values or `{ value, label }` objects.
 * `placeholder` adds a first option with value ''.
 * A controlled `value` of null/undefined is shown as '' (the placeholder),
 * which is what the original did and what React requires.
 */
export const Select = forwardRef(function Select({ options = [], placeholder, className, ...props }, ref) {
  const controlled = Object.prototype.hasOwnProperty.call(props, 'value');
  if (controlled && (props.value === null || props.value === undefined)) props = { ...props, value: '' };
  return (
    <select ref={ref} className={cx('select', className)} {...props}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((opt) => {
        const value = opt !== null && typeof opt === 'object' ? opt.value : opt;
        const label = opt !== null && typeof opt === 'object' ? opt.label : opt;
        return (
          <option key={String(value)} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
});

/**
 * Toggle switch. `onChange(checked, event)` receives the new boolean.
 * Pass `checked` to control it, or `defaultChecked` to let it hold its own
 * state (the original's behaviour: it flipped immediately and told you).
 */
export function SwitchToggle({ label, checked, defaultChecked, onChange, disabled, name }) {
  const control =
    checked === undefined ? { defaultChecked: Boolean(defaultChecked) } : { checked: Boolean(checked) };
  return (
    <label className="switch">
      <input
        type="checkbox"
        name={name}
        disabled={disabled}
        {...control}
        onChange={(e) => onChange?.(e.target.checked, e)}
      />
      <span className="track" />
      {label ? <span className="small">{label}</span> : null}
    </label>
  );
}
