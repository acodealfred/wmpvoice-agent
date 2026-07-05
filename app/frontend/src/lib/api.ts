// Centralized fetch for authenticated backend calls.
//
// On a POC the backend's session store (SQLite + in-memory state) is wiped
// whenever the single container is replaced — e.g. on every redeploy. After
// that, a browser still holding an old session cookie gets HTTP 401 from any
// authenticated endpoint. Routing those calls through apiFetch lets the app
// react once, centrally: it notifies a registered handler so the UI can drop
// back to the login screen instead of dead-ending on a raw "Session expired".
//
// Use this for authenticated endpoints only. Do NOT use it for /login (a 401
// there means bad credentials, handled locally) or the /me bootstrap check.

let authExpiredHandler: (() => void) | null = null;

/** Register the callback fired when an authenticated request returns 401. */
export function setAuthExpiredHandler(fn: (() => void) | null): void {
    authExpiredHandler = fn;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(input, { credentials: "same-origin", ...init });
    if (res.status === 401) {
        authExpiredHandler?.();
    }
    return res;
}
