// Hexis accounts site — single-page router that talks to
// api.hexis.chat (or localhost:4000 in dev) over cookie-auth fetch.
// Phase A shipped the /auth/web/* auth surface; Phase B adds
// client-side routing + a dashboard shell for /subscription,
// /billing, /api-keys, /bots, /gift, /gift/orders, and /redeem.

(() => {
  "use strict";

  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";

  const API_BASE = isLocal
    ? "http://localhost:4000"
    : "https://api.hexis.chat";

  const state = {
    // `null` until /auth/web/me or /auth/web/login resolves.
    user: null,
    // CSRF token from the most recent login. Memory-only; if the
    // user lands on the page with an existing cookie session we
    // won't have it and can't mutate until they re-sign-in.
    csrfToken: null,
    // `null` until /api/v1/account/summary resolves. Re-fetched
    // after route changes to the overview.
    summary: null,
  };

  // ── DOM ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const signInBtn = $("signin-btn");
  const signedInChip = $("signed-in");
  const signedInName = $("signed-in-name");
  const signOutBtn = $("signout-btn");
  const dialog = $("signin-dialog");
  const form = $("signin-form");
  const cancelBtn = $("signin-cancel");
  const closeBtn = $("signin-close");
  const submitBtn = $("signin-submit");
  const errorEl = $("signin-error");
  const usernameInput = $("signin-username");
  const passwordInput = $("signin-password");
  const landing = $("landing");
  const shell = $("shell");
  const view = $("view");

  // ── API helpers ──────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    if (opts.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (state.csrfToken && opts.method && opts.method !== "GET") {
      headers.set("x-csrf-token", state.csrfToken);
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
      /* no body or non-JSON */
    }
    return { status: res.status, body };
  }

  // ── Sign-in dialog ───────────────────────────────────────────────
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

  async function doLogin(username, password) {
    submitBtn.disabled = true;
    setError(null);
    try {
      const { status, body } = await apiFetch("/auth/web/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (status === 200 && body && body.ok) {
        state.csrfToken = body.csrf_token;
        state.user = body.user;
        closeDialog();
        await onSignedIn();
        return;
      }
      if (status === 401) setError("Invalid username or password.");
      else if (status === 400) setError("Username and password are required.");
      else setError("Sign-in failed. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function doLogout() {
    if (state.csrfToken) {
      await apiFetch("/auth/web/logout", { method: "POST", body: "{}" });
    }
    state.csrfToken = null;
    state.user = null;
    state.summary = null;
    navigate("/", { replace: true });
    render();
  }

  // ── Router ───────────────────────────────────────────────────────
  const routes = [
    { path: "/",                 render: renderOverview,       auth: true  },
    { path: "/subscription",     render: renderSubscription,   auth: true  },
    { path: "/billing",          render: renderBilling,        auth: true  },
    { path: "/billing/return",   render: renderBillingReturn,  auth: true  },
    { path: "/api-keys",         render: renderApiKeys,        auth: true  },
    { path: "/bots",             render: renderBots,           auth: true  },
    { path: "/gift",             render: renderGift,           auth: true  },
    { path: "/gift/orders",      render: renderGiftOrders,     auth: true  },
    { path: "/redeem",           render: renderRedeem,         auth: false },
  ];

  function matchRoute(path) {
    return routes.find((r) => r.path === path) || null;
  }

  function navigate(path, { replace = false } = {}) {
    if (path === location.pathname) return render();
    if (replace) history.replaceState({}, "", path);
    else history.pushState({}, "", path);
    render();
  }

  function render() {
    const path = location.pathname;
    const route = matchRoute(path);

    // Public routes (currently just /redeem) ignore auth state.
    if (route && !route.auth) {
      landing.hidden = true;
      shell.hidden = false;
      markActiveNav(path);
      route.render();
      return;
    }

    // Signed out → always show the landing, regardless of path.
    // When the user signs in we'll re-route to the originally
    // requested path.
    if (!state.user) {
      landing.hidden = false;
      shell.hidden = true;
      return;
    }

    landing.hidden = true;
    shell.hidden = false;
    markActiveNav(path);

    if (route) {
      route.render();
    } else {
      render404();
    }
  }

  function markActiveNav(path) {
    document.querySelectorAll(".nav-link").forEach((el) => {
      const href = el.getAttribute("href");
      const match = el.getAttribute("data-match") || href;
      el.classList.toggle("active", path === match);
    });
  }

  // ── Views ────────────────────────────────────────────────────────
  function html(strings, ...values) {
    // Tagged-template string escaper. Values are escaped unless
    // pre-marked with `.raw` on a wrapper object.
    const escape = (v) =>
      String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    return strings.reduce((out, str, i) => {
      const v = values[i];
      if (v === undefined || v === null) return out + str;
      if (typeof v === "object" && v && v.raw) return out + str + v.raw;
      if (Array.isArray(v)) return out + str + v.join("");
      return out + str + escape(v);
    }, "");
  }
  const raw = (r) => ({ raw: r });

  function setView(markup) {
    view.innerHTML = markup;
  }

  function pageHeader(title, lede) {
    return html`
      <section class="page-header">
        <h1>${title}</h1>
        <p class="lede">${lede}</p>
      </section>
    `;
  }

  function placeholderCard(heading, body) {
    return html`
      <div class="soon-card">
        <div class="soon-card-head">
          <h2>${heading}</h2>
          <span class="badge soon">soon</span>
        </div>
        <p>${body}</p>
      </div>
    `;
  }

  async function refreshSummary() {
    const { status, body } = await apiFetch("/api/v1/account/summary");
    if (status === 200 && body && body.ok) {
      state.summary = body;
      return body;
    }
    state.summary = null;
    return null;
  }

  function planLabel(plan) {
    if (!plan) return "Not active";
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }

  function statusLabel(status) {
    if (!status || status === "unsubscribed") return "No subscription";
    return status.replace(/_/g, " ");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }

  async function renderOverview() {
    setView(html`
      ${raw(pageHeader("Overview", `Welcome, ${state.user.display_name || state.user.username}.`))}
      <div id="overview-body">
        <p class="muted">Loading…</p>
      </div>
    `);

    const body = await refreshSummary();
    if (!body) {
      const b = $("overview-body");
      if (b) b.innerHTML = html`<p class="error">Couldn't load summary.</p>`;
      return;
    }

    const renewLine = body.cancel_at_period_end
      ? `Ends ${fmtDate(body.current_period_end)}`
      : body.current_period_end
      ? `Renews ${fmtDate(body.current_period_end)}`
      : "Memberships on this account";

    const b = $("overview-body");
    if (!b) return;
    b.innerHTML = html`
      <div class="overview-grid">
        <div class="stat">
          <div class="stat-label">Plan</div>
          <div class="stat-value">${planLabel(body.plan)}</div>
          <div class="stat-sub">Status: ${statusLabel(body.status)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Billing</div>
          <div class="stat-value">${body.plan ? "Active" : "—"}</div>
          <div class="stat-sub">${renewLine}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Servers</div>
          <div class="stat-value">${body.usage.server_count}</div>
          <div class="stat-sub">Memberships on this account</div>
        </div>
      </div>

      ${
        body.plan
          ? ""
          : raw(html`
              <div class="note">
                You don't have an active plan yet.
                <a href="/subscription" data-route>Pick one</a> to start using Hexis.
              </div>
            `)
      }
    `;
  }

  async function renderSubscription() {
    const body = state.summary || (await refreshSummary());
    const current = body && body.plan;

    setView(html`
      ${raw(
        pageHeader(
          "Subscription",
          current
            ? `You're on Hexis ${planLabel(current)}. Change plans any time.`
            : "Pick the plan that fits — upgrade or downgrade any time."
        )
      )}
      <div class="plan-grid">
        <div class="plan-card ${current === "core" ? "plan-card-active" : ""}">
          <div class="plan-head">
            <h2>Hexis Core</h2>
            <div class="plan-price">$12<span>/yr</span></div>
          </div>
          <ul class="plan-features">
            <li>Unlimited servers &amp; DMs</li>
            <li>64 kbps voice quality</li>
            <li>720p screen-share</li>
            <li>3 personal API keys</li>
          </ul>
          <button class="primary" type="button" data-checkout="core" ${
            current === "core" ? "disabled" : ""
          }>
            ${current === "core" ? "Current plan" : current ? "Switch to Core" : "Choose Core"}
          </button>
        </div>

        <div class="plan-card plan-card-pro ${current === "pro" ? "plan-card-active" : ""}">
          <div class="plan-head">
            <h2>Hexis Pro</h2>
            <div class="plan-price">$50<span>/yr</span></div>
          </div>
          <ul class="plan-features">
            <li>Everything in Core</li>
            <li>256 kbps voice quality</li>
            <li>1080p screen-share</li>
            <li>25 personal API keys</li>
            <li>Hexis Pro badge</li>
          </ul>
          <button class="primary" type="button" data-checkout="pro" ${
            current === "pro" ? "disabled" : ""
          }>
            ${current === "pro" ? "Current plan" : current ? "Switch to Pro" : "Choose Pro"}
          </button>
        </div>
      </div>

      <p class="muted">
        Checkout opens Stripe. We never see your card — Hexis only
        stores the subscription status mirrored back via webhook.
      </p>
    `);
  }

  async function renderBilling() {
    const body = state.summary || (await refreshSummary());
    const hasCustomer = body && body.plan;

    setView(html`
      ${raw(pageHeader("Billing", "Payment method, invoices, and receipts."))}
      ${
        hasCustomer
          ? raw(html`
              <div class="soon-card">
                <div class="soon-card-head">
                  <h2>Manage in Stripe</h2>
                </div>
                <p>
                  Payment method, past invoices, and cancel /
                  downgrade / upgrade all live in the Stripe
                  Customer Portal. You'll be bounced back here
                  when you're done.
                </p>
                <p style="margin-top: 12px;">
                  <button class="primary" type="button" id="btn-portal">
                    Open Customer Portal
                  </button>
                </p>
              </div>
            `)
          : raw(
              placeholderCard(
                "No billing yet",
                "You don't have an active plan, so there's nothing to manage. Pick a plan from the Subscription page to get started."
              )
            )
      }
    `);
  }

  async function renderBillingReturn() {
    setView(html`
      ${raw(pageHeader("Finishing up", "Waiting for Stripe to confirm."))}
      <p class="muted" id="return-msg">Checking your plan…</p>
    `);

    // Poll the summary endpoint until the webhook has landed and
    // flipped the customer to active (or until we've waited 15 s
    // — Stripe usually fires the webhook in under a second).
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const body = await refreshSummary();
      if (body && body.plan) {
        const msg = $("return-msg");
        if (msg) {
          msg.textContent = `You're on Hexis ${planLabel(body.plan)}. Redirecting…`;
        }
        setTimeout(() => navigate("/billing", { replace: true }), 700);
        return;
      }
      await sleep(1000);
    }

    const msg = $("return-msg");
    if (msg) {
      msg.innerHTML = html`
        We haven't heard back from Stripe yet. It usually arrives
        in seconds — refresh the Overview page in a moment, or
        <a href="/billing" data-route>jump to Billing</a>.
      `;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function doCheckout(plan) {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }
    const { status, body } = await apiFetch("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
    if (status === 200 && body && body.checkout_url) {
      window.location.href = body.checkout_url;
      return;
    }
    alert("Couldn't start Stripe checkout. Please try again.");
  }

  async function doPortal() {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }
    const { status, body } = await apiFetch("/billing/portal", {
      method: "POST",
      body: "{}",
    });
    if (status === 200 && body && body.portal_url) {
      window.location.href = body.portal_url;
      return;
    }
    alert("Couldn't open Customer Portal. Please try again.");
  }

  async function renderApiKeys() {
    setView(html`
      ${raw(pageHeader("API keys", "Scoped, revocable tokens for personal automation and CI."))}
      <div id="keys-body">
        <p class="muted">Loading…</p>
      </div>
    `);

    const { status, body } = await apiFetch("/api/v1/keys");
    const bodyEl = $("keys-body");
    if (!bodyEl) return;

    if (status !== 200 || !body || !body.ok) {
      bodyEl.innerHTML = html`<p class="error">Couldn't load keys.</p>`;
      return;
    }

    const keys = body.keys || [];
    const scopes = body.known_scopes || [];

    bodyEl.innerHTML = html`
      <div class="keys-toolbar">
        <button class="primary" type="button" id="btn-new-key">New key</button>
      </div>

      ${
        keys.length === 0
          ? raw(html`
              <div class="soon-card">
                <div class="soon-card-head"><h2>No keys yet</h2></div>
                <p>
                  Press "New key" to mint one. Keys carry a subset
                  of your account's permissions and can be revoked
                  from this page at any time.
                </p>
              </div>
            `)
          : raw(html`
              <table class="keys-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Scopes</th>
                    <th>Last used</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${raw(keys.map(keyRow).join(""))}
                </tbody>
              </table>
            `)
      }
    `;

    // Stash the scope list on the button so the dialog renders it
    // without refetching. Using dataset so the renderer stays
    // declarative.
    const btn = $("btn-new-key");
    if (btn) btn.dataset.scopes = JSON.stringify(scopes);
  }

  function keyRow(k) {
    return html`
      <tr>
        <td><strong>${k.name}</strong><div class="key-id">${k.public_id}</div></td>
        <td>${k.scopes && k.scopes.length ? k.scopes.join(", ") : "—"}</td>
        <td>${k.last_used_at ? fmtDate(k.last_used_at) : "never"}</td>
        <td>${fmtDate(k.created_at)}</td>
        <td><button class="ghost" type="button" data-revoke="${k.public_id}">Revoke</button></td>
      </tr>
    `;
  }

  function openNewKeyDialog(scopes) {
    const dialog = ensureKeyDialog();
    const form = dialog.querySelector("form");
    form.reset();
    form.querySelector("[data-role=error]").hidden = true;

    const scopeList = form.querySelector("[data-role=scopes]");
    scopeList.innerHTML = scopes
      .map(
        (s) => html`
          <label class="scope-check">
            <input type="checkbox" name="scope" value="${s}" />
            <span>${s}</span>
          </label>
        `
      )
      .join("");

    form.querySelector("[data-role=token-reveal]").hidden = true;
    form.querySelector("[data-role=inputs]").hidden = false;
    form.querySelector("[data-role=submit]").hidden = false;
    form.querySelector("[data-role=close]").textContent = "Cancel";

    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "open");
  }

  function ensureKeyDialog() {
    let dialog = document.getElementById("new-key-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "new-key-dialog";
    dialog.className = "signin-dialog key-dialog";
    dialog.innerHTML = html`
      <form method="dialog">
        <header>
          <h3>New API key</h3>
          <button type="button" class="dialog-close" data-role="close" aria-label="Close">×</button>
        </header>

        <div data-role="inputs">
          <label for="new-key-name">Name</label>
          <input
            type="text"
            id="new-key-name"
            name="name"
            placeholder="e.g. CI deploy"
            required
          />

          <label>Scopes</label>
          <div class="scope-list" data-role="scopes"></div>

          <p class="signin-error" data-role="error" hidden></p>
        </div>

        <div data-role="token-reveal" hidden>
          <p class="token-warning">
            <strong>Copy this token now.</strong> We won't show it
            again — if you lose it, revoke and create a new key.
          </p>
          <input type="text" data-role="token" readonly />
        </div>

        <div class="signin-actions">
          <button type="button" class="ghost" data-role="cancel">Cancel</button>
          <button type="submit" class="primary" data-role="submit">Create key</button>
        </div>
      </form>
    `;

    document.body.appendChild(dialog);

    const form = dialog.querySelector("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitNewKey(dialog);
    });
    dialog.querySelector("[data-role=close]").addEventListener("click", () =>
      closeKeyDialog(dialog)
    );
    dialog.querySelector("[data-role=cancel]").addEventListener("click", () =>
      closeKeyDialog(dialog)
    );
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeKeyDialog(dialog);
    });

    return dialog;
  }

  function closeKeyDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    // Refresh the keys view after any close (it may have been a
    // post-create reveal; either way the list may have changed).
    if (location.pathname === "/api-keys") renderApiKeys();
  }

  async function submitNewKey(dialog) {
    const form = dialog.querySelector("form");
    const name = form.querySelector("#new-key-name").value.trim();
    const scopes = Array.from(form.querySelectorAll("input[name=scope]:checked")).map(
      (i) => i.value
    );

    const errEl = form.querySelector("[data-role=error]");
    errEl.hidden = true;

    if (!state.csrfToken) {
      errEl.textContent = "Please sign in again.";
      errEl.hidden = false;
      return;
    }

    const { status, body } = await apiFetch("/api/v1/keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    });

    if (status === 201 && body && body.ok) {
      form.querySelector("[data-role=inputs]").hidden = true;
      form.querySelector("[data-role=submit]").hidden = true;
      form.querySelector("[data-role=close]").textContent = "Done";
      form.querySelector("[data-role=cancel]").textContent = "Done";
      const reveal = form.querySelector("[data-role=token-reveal]");
      reveal.hidden = false;
      const tokenInput = form.querySelector("[data-role=token]");
      tokenInput.value = body.raw_token;
      tokenInput.select();
      return;
    }

    if (status === 409) {
      errEl.textContent = "You've hit your plan's API-key quota.";
    } else if (status === 400) {
      errEl.textContent = "That scope isn't available.";
    } else {
      errEl.textContent = "Couldn't create the key. Please try again.";
    }
    errEl.hidden = false;
  }

  async function revokeKey(publicId) {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }
    if (!confirm("Revoke this key? Any script using it will stop working.")) return;

    const { status } = await apiFetch(`/api/v1/keys/${encodeURIComponent(publicId)}`, {
      method: "DELETE",
    });

    if (status === 200 || status === 204) {
      renderApiKeys();
    } else {
      alert("Revoke failed. Please try again.");
    }
  }

  async function renderBots() {
    setView(html`
      ${raw(pageHeader("Bots", "Register OAuth 2.1 + PKCE applications."))}
      <div id="bots-body">
        <p class="muted">Loading…</p>
      </div>
    `);

    const { status, body } = await apiFetch("/api/v1/oauth/apps");
    const bodyEl = $("bots-body");
    if (!bodyEl) return;

    if (status !== 200 || !body || !body.ok) {
      bodyEl.innerHTML = html`<p class="error">Couldn't load apps.</p>`;
      return;
    }

    const apps = body.apps || [];
    const scopes = body.known_scopes || [];

    bodyEl.innerHTML = html`
      <div class="keys-toolbar">
        <button class="primary" type="button" id="btn-new-bot">Register new app</button>
      </div>

      ${
        apps.length === 0
          ? raw(html`
              <div class="soon-card">
                <div class="soon-card-head"><h2>No apps yet</h2></div>
                <p>
                  Register an OAuth 2.1 application to let it act
                  on a user's behalf. Public clients (CLI / desktop
                  bots) get PKCE-only auth; confidential clients
                  (server-side bots) also get a one-shot
                  client_secret.
                </p>
                <p class="muted" style="margin-top: 8px;">
                  New apps start as "Pending" — a Hexis admin has to
                  approve them before they can complete a token
                  exchange.
                </p>
              </div>
            `)
          : raw(html`
              <div class="bots-grid">
                ${raw(apps.map(botCard).join(""))}
              </div>
            `)
      }
    `;

    const btn = $("btn-new-bot");
    if (btn) btn.dataset.scopes = JSON.stringify(scopes);
  }

  function botCard(app) {
    const badge = app.approved
      ? '<span class="badge-pill badge-ok">Approved</span>'
      : '<span class="badge-pill badge-pending">Pending review</span>';

    const typeLabel = app.is_public_client
      ? "public (PKCE-only)"
      : "confidential";

    return html`
      <div class="bot-card">
        <div class="bot-head">
          <h2>${app.name}</h2>
          ${raw(badge)}
        </div>
        ${app.description ? html`<p class="muted">${app.description}</p>` : ""}
        <dl class="bot-meta">
          <dt>Type</dt><dd>${typeLabel}</dd>
          <dt>Redirect URIs</dt>
          <dd>${app.redirect_uris.join(", ") || "—"}</dd>
          <dt>Scopes</dt>
          <dd>${app.scopes && app.scopes.length ? app.scopes.join(", ") : (app.allowed_scopes && app.allowed_scopes.join(", ")) || "—"}</dd>
          <dt>Created</dt><dd>${fmtDate(app.created_at)}</dd>
        </dl>
        <div class="bot-actions">
          <button class="ghost" type="button" data-revoke-bot="${app.public_id}">Delete</button>
        </div>
      </div>
    `;
  }

  function openNewBotDialog(scopes) {
    const dialog = ensureBotDialog();
    const form = dialog.querySelector("form");
    form.reset();
    form.querySelector("[data-role=error]").hidden = true;

    const scopeList = form.querySelector("[data-role=scopes]");
    scopeList.innerHTML = scopes
      .map(
        (s) => html`
          <label class="scope-check">
            <input type="checkbox" name="scope" value="${s}" />
            <span>${s}</span>
          </label>
        `
      )
      .join("");

    form.querySelector("[data-role=inputs]").hidden = false;
    form.querySelector("[data-role=submit]").hidden = false;
    form.querySelector("[data-role=reveal]").hidden = true;
    form.querySelector("[data-role=close]").textContent = "Cancel";

    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "open");
  }

  function ensureBotDialog() {
    let dialog = document.getElementById("new-bot-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "new-bot-dialog";
    dialog.className = "signin-dialog key-dialog";
    dialog.innerHTML = html`
      <form method="dialog">
        <header>
          <h3>Register OAuth app</h3>
          <button type="button" class="dialog-close" data-role="close" aria-label="Close">×</button>
        </header>

        <div data-role="inputs">
          <label for="new-bot-name">Name</label>
          <input type="text" id="new-bot-name" name="name" required />

          <label for="new-bot-desc">Description (optional)</label>
          <input type="text" id="new-bot-desc" name="description" />

          <label for="new-bot-homepage">Homepage URL (optional)</label>
          <input type="url" id="new-bot-homepage" name="homepage_url"
                 placeholder="https://example.com" />

          <label for="new-bot-redirects">Redirect URIs (one per line)</label>
          <textarea id="new-bot-redirects" name="redirect_uris" rows="3"
                    placeholder="https://example.com/oauth/callback&#10;hexis://oauth/callback"></textarea>

          <label>Requested scopes</label>
          <div class="scope-list" data-role="scopes"></div>

          <label class="scope-check" style="margin-top: 12px;">
            <input type="checkbox" id="new-bot-public" name="is_public_client" />
            <span>Public client (native / CLI — no client secret, PKCE-only)</span>
          </label>

          <p class="signin-error" data-role="error" hidden></p>
        </div>

        <div data-role="reveal" hidden>
          <p class="token-warning">
            <strong>Copy your credentials now.</strong> The client
            secret is shown only once. If you lose it, delete the
            app and register a new one.
          </p>
          <label>Client ID</label>
          <input type="text" data-role="client-id" readonly />
          <label data-role="secret-label">Client secret</label>
          <input type="text" data-role="client-secret" readonly />
          <p class="muted" style="margin-top: 10px;">
            Your app is pending admin approval. Once approved,
            it can complete the OAuth 2.1 + PKCE authorization-code
            flow.
          </p>
        </div>

        <div class="signin-actions">
          <button type="button" class="ghost" data-role="cancel">Cancel</button>
          <button type="submit" class="primary" data-role="submit">Register</button>
        </div>
      </form>
    `;

    document.body.appendChild(dialog);

    const form = dialog.querySelector("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitNewBot(dialog);
    });
    dialog.querySelector("[data-role=close]").addEventListener("click", () =>
      closeBotDialog(dialog)
    );
    dialog.querySelector("[data-role=cancel]").addEventListener("click", () =>
      closeBotDialog(dialog)
    );
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeBotDialog(dialog);
    });

    return dialog;
  }

  function closeBotDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    if (location.pathname === "/bots") renderBots();
  }

  async function submitNewBot(dialog) {
    const form = dialog.querySelector("form");
    const errEl = form.querySelector("[data-role=error]");
    errEl.hidden = true;

    if (!state.csrfToken) {
      errEl.textContent = "Please sign in again.";
      errEl.hidden = false;
      return;
    }

    const name = form.querySelector("#new-bot-name").value.trim();
    const description = form.querySelector("#new-bot-desc").value.trim();
    const homepage_url = form.querySelector("#new-bot-homepage").value.trim();
    const redirect_uris = form
      .querySelector("#new-bot-redirects")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowed_scopes = Array.from(
      form.querySelectorAll("input[name=scope]:checked")
    ).map((i) => i.value);
    const is_public_client = form.querySelector("#new-bot-public").checked;

    const { status, body } = await apiFetch("/api/v1/oauth/apps", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: description || null,
        homepage_url: homepage_url || null,
        redirect_uris,
        allowed_scopes,
        is_public_client,
      }),
    });

    if (status === 201 && body && body.ok) {
      form.querySelector("[data-role=inputs]").hidden = true;
      form.querySelector("[data-role=submit]").hidden = true;
      form.querySelector("[data-role=close]").textContent = "Done";
      form.querySelector("[data-role=cancel]").textContent = "Done";
      const reveal = form.querySelector("[data-role=reveal]");
      reveal.hidden = false;
      form.querySelector("[data-role=client-id]").value = body.app.client_id;
      const secretEl = form.querySelector("[data-role=client-secret]");
      const secretLabel = form.querySelector("[data-role=secret-label]");
      if (body.client_secret) {
        secretEl.value = body.client_secret;
        secretEl.hidden = false;
        secretLabel.hidden = false;
      } else {
        secretEl.hidden = true;
        secretLabel.hidden = true;
      }
      return;
    }

    if (status === 400) errEl.textContent = "One of those scopes isn't available.";
    else if (status === 422) errEl.textContent = "Check your redirect URIs (https:// or a custom scheme) and other fields.";
    else errEl.textContent = "Couldn't register the app. Please try again.";
    errEl.hidden = false;
  }

  async function revokeBot(publicId) {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }
    if (!confirm("Delete this app? Any tokens it has issued stop working.")) return;

    const { status } = await apiFetch(`/api/v1/oauth/apps/${encodeURIComponent(publicId)}`, {
      method: "DELETE",
    });

    if (status === 200) renderBots();
    else alert("Delete failed. Please try again.");
  }

  function renderGift() {
    setView(html`
      ${raw(pageHeader("Gift codes", "Buy a pack to onboard friends."))}
      <div class="plan-grid">
        <div class="plan-card">
          <div class="plan-head">
            <h2>5-pack</h2>
            <div class="plan-price">$50<span> one-time</span></div>
          </div>
          <p class="plan-sub">$10 / code · 5 one-year Core invites</p>
          <button class="primary" type="button" disabled>Coming soon</button>
        </div>
        <div class="plan-card plan-card-pro">
          <div class="plan-head">
            <h2>10-pack</h2>
            <div class="plan-price">$80<span> one-time</span></div>
          </div>
          <p class="plan-sub">$8 / code · 10 one-year Core invites</p>
          <button class="primary" type="button" disabled>Coming soon</button>
        </div>
      </div>
      ${raw(
        placeholderCard(
          "How redemption works",
          "Each code lets a brand-new friend create an account with the first year of Core prepaid. After year one, their card on file auto-renews at $12/yr — cancellable from their account. Redemption is account-creation-only; existing accounts can't apply codes."
        )
      )}
    `);
  }

  function renderGiftOrders() {
    setView(html`
      ${raw(pageHeader("Past gift orders", "Codes from packs you've purchased."))}
      ${raw(
        placeholderCard(
          "No orders yet",
          "Buying a pack from the Gift codes page will list it here with a copy-each affordance for each code. Unredeemed codes can be revoked for a partial refund until the 1-year expiry."
        )
      )}
    `);
  }

  function renderRedeem() {
    const params = new URLSearchParams(location.search);
    const prefill = params.get("code") || "";
    setView(html`
      ${raw(
        pageHeader(
          "Redeem a gift code",
          "Create a new Hexis account with a year of Core prepaid."
        )
      )}
      <div class="redeem-card">
        <label for="redeem-code">Gift code</label>
        <input
          type="text"
          id="redeem-code"
          value="${prefill}"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="primary" type="button" disabled>Continue (soon)</button>
        <p class="muted">
          This flow ships once gift codes are live. Gift codes work
          only when creating a new account — existing users can't
          apply them to an existing subscription.
        </p>
      </div>
    `);
  }

  function render404() {
    setView(html`
      ${raw(pageHeader("Not found", "That page doesn't exist."))}
      <p>
        <a href="/" data-route>Back to the dashboard</a>
      </p>
    `);
  }

  async function onSignedIn() {
    signInBtn.hidden = true;
    signedInChip.hidden = false;
    signedInName.textContent =
      state.user.display_name || state.user.username;
    render();
  }

  function onSignedOut() {
    signedInChip.hidden = true;
    signInBtn.hidden = false;
    signedInName.textContent = "";
    render();
  }

  // ── Startup ──────────────────────────────────────────────────────
  async function loadCurrentUser() {
    const { status, body } = await apiFetch("/auth/web/me");
    if (status === 200 && body && body.ok) {
      state.user = body.user;
      await onSignedIn();
    } else {
      onSignedOut();
    }
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

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog();
  });

  // Delegate any `data-route` anchor click to the router so deep
  // links between routes don't trigger a full page reload. External
  // links (no data-route) bypass this.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-route]");
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("//")) return;
    e.preventDefault();
    navigate(href);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-landing-signin]");
    if (btn) openDialog();
  });

  // Plan checkout buttons on /subscription.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-checkout]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const plan = btn.getAttribute("data-checkout");
    doCheckout(plan);
  });

  // "Open Customer Portal" button on /billing.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#btn-portal");
    if (!btn) return;
    e.preventDefault();
    doPortal();
  });

  // "New key" button on /api-keys.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#btn-new-key");
    if (!btn) return;
    e.preventDefault();
    let scopes = [];
    try {
      scopes = JSON.parse(btn.dataset.scopes || "[]");
    } catch {
      /* empty fine */
    }
    openNewKeyDialog(scopes);
  });

  // Per-row revoke.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-revoke]");
    if (!btn) return;
    e.preventDefault();
    revokeKey(btn.getAttribute("data-revoke"));
  });

  // "Register new app" button on /bots.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#btn-new-bot");
    if (!btn) return;
    e.preventDefault();
    let scopes = [];
    try {
      scopes = JSON.parse(btn.dataset.scopes || "[]");
    } catch {
      /* empty fine */
    }
    openNewBotDialog(scopes);
  });

  // Per-app delete.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-revoke-bot]");
    if (!btn) return;
    e.preventDefault();
    revokeBot(btn.getAttribute("data-revoke-bot"));
  });

  window.addEventListener("popstate", render);

  loadCurrentUser();
})();
