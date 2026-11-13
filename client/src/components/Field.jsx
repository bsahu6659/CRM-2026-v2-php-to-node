/**
 * Labelled form control with inline validation text. Port of ui.js `field()`.
 *
 * The server returns 422 with a `details` array keyed by field name; `error`
 * is whatever that array said about this one (`err.fieldErrors[name]`), so a
 * validation failure lands next to the input that caused it instead of in a
 * banner at the top. As in the original, the hint stays visible under the
 * error.
 */
export default function Field({ label, error, hint, required, htmlFor, className, children }) {
  return (
    <div className={className ? `field ${className}` : 'field'}>
      {label !== undefined && label !== null && (
        <label htmlFor={htmlFor}>
          {label}
          {required ? <span className="req-star"> *</span> : null}
        </label>
      )}
      {children}
      {error ? <div className="err">{error}</div> : null}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
