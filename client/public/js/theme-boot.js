/**
 * Theme bootstrap.
 *
 * Applies the saved theme before first paint so a dark-theme user never sees a
 * white flash. It lives in its own file rather than an inline <script> because
 * the app's Content-Security-Policy is `script-src 'self'` — no inline scripts,
 * no `unsafe-inline` escape hatch.
 */
(function () {
  try {
    if (localStorage.getItem('gv.theme') === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {
    // Private browsing or blocked storage: fall back to the light default.
  }
})();
