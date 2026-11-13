/**
 * API client.
 *
 * One place that knows about the response envelope ({ data, meta } / { error }),
 * the CSRF header, and what a 401 means. Components never touch `fetch`
 * directly, so error handling and session expiry behave identically everywhere.
 *
 * The wire contract is identical to the PHP edition's — same paths, same
 * envelope, same camelCase keys — so this file is a direct port.
 */

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code || 'UNKNOWN';
    this.details = payload?.error?.details || null;
  }

  /** Field-keyed map for inline form errors. */
  get fieldErrors() {
    const out = {};
    for (const d of this.details || []) if (d.field) out[d.field] = d.message;
    return out;
  }
}

/**
 * The server sets gv_csrf with httpOnly off precisely so this can read it:
 * a double-submit cookie proves the request came from a page on our origin
 * rather than from a cross-site form post.
 */
function csrfToken() {
  const match = /(?:^|;\s*)gv_csrf=([^;]+)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : '';
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

async function request(method, path, { body, query, raw = false, signal, headers = {} } = {}) {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  const init = {
    method,
    credentials: 'same-origin',
    signal,
    headers: { 'x-csrf-token': csrfToken(), ...headers },
  };

  if (body instanceof FormData) {
    init.body = body; // let the browser set the multipart boundary
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (res.status === 401) {
    // A failed sign-in is also a 401, and the server says exactly what was
    // wrong with it — "Email or password is incorrect". Replacing that with
    // "your session has expired" sends someone hunting for a session problem
    // when they have simply mistyped a password. Keep the server's message
    // whenever there is one; only invent the session wording for a request
    // that lost an existing session.
    const payload = await res.json().catch(() => null);
    const isSignIn = url.pathname.endsWith('/api/auth/login');
    if (!isSignIn) onUnauthorized();
    throw new ApiError(
      401,
      payload?.error?.message
        ? payload
        : { error: { code: 'UNAUTHENTICATED', message: 'Your session has expired. Please sign in again.' } }
    );
  }

  if (res.status === 204) return null;

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res;
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export const api = {
  get: (path, query, opts) => request('GET', path, { query, ...opts }),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  put: (path, body, opts) => request('PUT', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),

  /** Returns the `data` member directly for callers that ignore `meta`. */
  async data(path, query, opts) {
    const res = await request('GET', path, { query, ...opts });
    return res?.data;
  },

  /**
   * Triggers a browser download for an export endpoint. Uses a blob so the
   * request carries credentials and the CSRF header like every other call.
   */
  async download(path, query, filename) {
    const res = await request('GET', path, { query, raw: true });
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || match?.[1] || 'growvanta-export.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  upload(path, formData) {
    return request('POST', path, { body: formData });
  },
};

export default api;
