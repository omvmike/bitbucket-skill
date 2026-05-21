export const EXIT = Object.freeze({
  OK: 0,
  CONFIG: 2,
  NOT_FOUND: 3,
  VALIDATION: 4,
  NETWORK: 5,
  RATE_LIMIT: 6,
});

const BASE_URL = 'https://api.bitbucket.org/2.0';

function authHeader({ user, token }) {
  if (!token) return null;
  if (user) {
    const b64 = Buffer.from(`${user}:${token}`).toString('base64');
    return `Basic ${b64}`;
  }
  return `Bearer ${token}`;
}

export class ApiError extends Error {
  constructor(message, { exit, status, body } = {}) {
    super(message);
    this.exit = exit ?? EXIT.NETWORK;
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

function mapStatus(status) {
  if (status === 401 || status === 403) return EXIT.CONFIG;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMIT;
  if (status >= 500) return EXIT.NETWORK;
  return EXIT.NETWORK;
}

async function request({ method = 'GET', path, query, body, auth, timeoutMs, accept = 'application/json' }) {
  if (!auth) throw new ApiError('BB_TOKEN is missing (no auth header built)', { exit: EXIT.CONFIG });
  const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Authorization: auth, Accept: accept };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new ApiError(`timeout after ${timeoutMs}ms on ${method} ${url.pathname}`, { exit: EXIT.NETWORK });
    throw new ApiError(`network error on ${method} ${url.pathname}: ${err.message}`, { exit: EXIT.NETWORK });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const exit = mapStatus(res.status);
    const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    const extras = [];
    if (res.status === 429) {
      const retry = res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset');
      if (retry) extras.push(`retry-after=${retry}`);
    }
    throw new ApiError(
      `HTTP ${res.status} on ${method} ${url.pathname}${extras.length ? ` (${extras.join(', ')})` : ''}: ${preview}`,
      { exit, status: res.status, body: preview },
    );
  }

  if (res.status === 204) return null;
  if (accept === 'application/json') return res.json();
  return res.text();
}

export function makeClient({ user, token, timeoutMs = 15000 }) {
  const auth = authHeader({ user, token });
  return {
    async get(path, query, { accept } = {}) {
      return request({ method: 'GET', path, query, auth, timeoutMs, accept });
    },
    async post(path, body) {
      // Bitbucket's POST /comments/{id}/resolve rejects an empty body with 400 —
      // callers must pass at least {} to opt into Content-Type: application/json.
      return request({ method: 'POST', path, body, auth, timeoutMs });
    },
    async put(path, body) {
      return request({ method: 'PUT', path, body, auth, timeoutMs });
    },
    async delete(path) {
      return request({ method: 'DELETE', path, auth, timeoutMs });
    },
    async paginated(path, query, { limit }) {
      const results = [];
      let next = null;
      let firstQuery = { ...query, pagelen: Math.min(limit, 50) };
      let page = await request({ method: 'GET', path, query: firstQuery, auth, timeoutMs });
      for (const v of page.values ?? []) {
        results.push(v);
        if (results.length >= limit) return { values: results, size: page.size, truncated: true };
      }
      next = page.next ?? null;
      while (next && results.length < limit) {
        page = await request({ method: 'GET', path: next, auth, timeoutMs });
        for (const v of page.values ?? []) {
          results.push(v);
          if (results.length >= limit) return { values: results, size: page.size, truncated: true };
        }
        next = page.next ?? null;
      }
      return { values: results, size: page.size, truncated: false };
    },
  };
}
