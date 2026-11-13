import { Component } from 'react';

/**
 * Catches a render error below it and shows `fallback(error)` instead of
 * unmounting the whole application. `onError(error)` is told about it once.
 *
 * Used around every routed page (App.jsx) and around every overlay opened
 * through `openOverlay()`, so one broken screen or form cannot blank the
 * shell around it.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback(this.state.error) : (fallback ?? null);
    }
    return this.props.children;
  }
}

/**
 * The PHP router's `renderRouteError()`: what a page that failed to load or
 * render shows in place of itself.
 */
export function RouteError({ error }) {
  return (
    <div className="card">
      <div className="empty">
        <h3>This page could not be loaded</h3>
        <p>{error?.message || 'An unexpected error occurred.'}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
