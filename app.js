// Hexis accounts site — minimal client glue for the Phase A web auth
// surface. Talks to api.hexis.chat (or localhost:4000 in dev) over
// fetch with credentials, drops a sign-in dialog, and shows the
// signed-in name + sign-out affordance in the topbar.

(() => {
  "use strict";

  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";

  const API_BASE = isLocal
    ? "http://localhost:4000"
    : "https://api.hexis.chat";

  // Per-tab CSRF token. Issued on login, echoed on every mutating
  // request as `X-CSRF-Token`. Memory-only — never persisted.
  let csrfToken = null;

  // ── DOM lookups ──────────────────────────────────────────────────
  const signInBtn = document.getElementById("signin-btn");
  const signedIn = document.getElementById("signed-in");
  const signedInName = document.getElementById("signed-in-name");
  const signOutBtn = document.getElementById("signout-btn");
  const dialog = document.getElementById("signin-dialog");
  const form = document.getElementById("signin-form");
  const cancelBtn = document.getElementById("signin-cancel");
  const closeBtn = document.getElementById("signin-close");
  const submitBtn = document.getElementById("signin-submit");
  const errorEl = document.getElementById("signin-error");
  const usernameInput = document.getElementById("signin-username");
  const passwordInput = document.getElementById("signin-password");

  // ── API helpers ──────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    if (opts.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (csrfToken && opts.method && opts.method !== "GET") {
      headers.set("x-csrf-token", csrfToken);
    }
    const res = await fetch(API_BASE + path, {
      credentials: "include",
      ...opts,
      headers,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  // ── UI state ─────────────────────────────────────────────────────
  function showSignedIn(user) {
    signInBtn.hidden = true;
    signedIn.hidden = false;
    signedInName.textContent = user.display_name || user.username;
  }

  function showSignedOut() {
    signedIn.hidden = true;
    signInBtn.hidden = false;
    signedInName.textContent = "";
    csrfToken = null;
  }

  function setError(msg) {
    if (msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    } else {
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
  }

  function openDialog() {
    setError(null);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "open");
    }
    setTimeout(() => usernameInput.focus(), 0);
  }

  function closeDialog() {
    setError(null);
    form.reset();
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  // ── Flows ────────────────────────────────────────────────────────
  async function loadCurrentUser() {
    const { status, body } = await apiFetch("/auth/web/me");
    if (status === 200 && body && body.ok) {
      // We don't have the CSRF token from this path — `/me` doesn't
      // re-issue. The session is good but we can't mutate without
      // re-logging in. For Phase A this is fine: the only mutation
      // the user can perform without re-logging is sign-out, which
      // is itself a CSRF-required POST. We surface a "session
      // detected" view; sign-out asks them to log in again first.
      // (Phase B will introduce a `/auth/web/csrf` rotate endpoint.)
      showSignedIn(body.user);
    } else {
      showSignedOut();
    }
  }

  async function doLogin(username, password) {
    submitBtn.disabled = true;
    setError(null);
    try {
      const { status, body } = await apiFetch("/auth/web/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (status === 200 && body && body.ok) {
        csrfToken = body.csrf_token;
        showSignedIn(body.user);
        closeDialog();
        return;
      }
      if (status === 401) {
        setError("Invalid username or password.");
      } else if (status === 400) {
        setError("Username and password are required.");
      } else {
        setError("Sign-in failed. Please try again.");
      }
    } catch (e) {
      setError("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function doLogout() {
    if (!csrfToken) {
      // No CSRF in memory (e.g. signed-in via cookie from a prior
      // page load). Fall through and clear local state — the cookie
      // will eventually expire server-side; user can sign in again
      // to fully revoke.
      showSignedOut();
      return;
    }
    await apiFetch("/auth/web/logout", { method: "POST", body: "{}" });
    showSignedOut();
  }

  // ── Wire-up ──────────────────────────────────────────────────────
  signInBtn.addEventListener("click", openDialog);
  cancelBtn.addEventListener("click", closeDialog);
  closeBtn.addEventListener("click", closeDialog);
  signOutBtn.addEventListener("click", doLogout);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      setError("Username and password are required.");
      return;
    }
    doLogin(username, password);
  });

  // Pressing Esc on the native dialog fires a `cancel` event.
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog();
  });

  loadCurrentUser();
})();
