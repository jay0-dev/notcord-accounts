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

  // Phase F — sticky "from app" flag. The Hexis thick client
  // appends ?return=app when it opens us in the system browser
  // ("Manage subscription", "Manage API keys", etc.). Stash it in
  // sessionStorage so it survives the Stripe round-trip; clear
  // when the user explicitly leaves the dashboard.
  if (new URLSearchParams(location.search).get("return") === "app") {
    try { sessionStorage.setItem("hexis_from_app", "1"); } catch {}
  }
  const fromApp = () => {
    try { return sessionStorage.getItem("hexis_from_app") === "1"; } catch { return false; }
  };

  // Build a hexis:// deep link target appropriate for `where`.
  const deepLink = (where) => {
    switch (where) {
      case "billing": return "hexis://billing/return";
      case "api-keys": return "hexis://settings/api-keys";
      case "bots": return "hexis://settings/bots";
      default: return "hexis://" + where;
    }
  };

  // Render an "Open Hexis app" CTA when fromApp() is true. Returns
  // an HTML fragment string (caller wraps with html`${raw(...)}`).
  const openAppCta = (where, label) => {
    if (!fromApp()) return "";
    const target = deepLink(where);
    return `
      <div class="open-app-cta">
        <a class="primary" href="${target}">${label || "Open Hexis app"}</a>
        <p class="muted">Or stay here — close this tab when you're done.</p>
      </div>
    `;
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
        // Phase J6.5 — username+password verified, but the
        // account has 2FA enrolled. Don't close the dialog yet;
        // ask for the 6-digit code (or backup code).
        if (body.requires_totp && body.challenge_token) {
          await promptTotpForLogin(body.challenge_token);
          return;
        }

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
    // /auth/web/logout is CSRF-exempt (logout has no destructive
    // user-data impact and SPA reloads can lose the in-memory
    // CSRF token), so we can always call it even without one.
    await apiFetch("/auth/web/logout", { method: "POST", body: "{}" });
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
    { path: "/gift",             render: renderGift,           auth: false },
    { path: "/gift/orders",      render: renderGiftOrders,     auth: true  },
    { path: "/redeem",           render: renderRedeem,         auth: false },
    { path: "/oauth/authorize",  render: renderOauthAuthorize, auth: false },
    { path: "/redeem/return",    render: renderRedeemReturn,   auth: false },
    // Phase J5 — browser register + onboarding flow.
    { path: "/register",         render: renderRegister,         auth: false },
    { path: "/welcome",          render: renderWelcome,          auth: true  },
    { path: "/verify-email/done",render: renderVerifyEmailDone,  auth: false },
    { path: "/forgot-password",  render: renderForgotPassword,   auth: false },
    { path: "/reset-password",   render: renderResetPassword,    auth: false },
    { path: "/setup-2fa",        render: renderSetupTotp,        auth: true  },
    { path: "/move-squad",       render: renderMoveSquad,        auth: true  },
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
      applyNavVisibility(body);
      return body;
    }
    state.summary = null;
    return null;
  }

  // Hide the "Redeem a gift code" sidebar entry once the user has
  // either subscribed (or had a subscription in the past) or
  // already redeemed a code — the /redeem flow itself is for
  // fresh accounts only and the link would just confuse them.
  function applyNavVisibility(summary) {
    const link = document.querySelector('aside.sidebar a[href="/redeem"]');
    if (!link) return;
    link.hidden = !(summary && summary.gift_redemption_eligible);
  }

  function planLabel(plan) {
    if (!plan) return "Not active";
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }

  // Render the "Choose / Upgrade / Current" button for one plan
  // card. `target` is the tile this button lives in (core/pro);
  // `current` is the user's active plan ("core"|"pro"|null).
  //
  // - No active plan: "Choose X" → /billing/checkout (Stripe).
  // - Active plan = this tile: "Current plan" disabled.
  // - Active Core, looking at Pro tile: "Upgrade to Pro" →
  //   /billing/switch (Customer Portal with proration).
  // - Active Pro, looking at Core tile: NO downgrade button.
  //   Pro is one-way; the user has to cancel via the Customer
  //   Portal and resubscribe to Core if they really want to
  //   step down. Surfacing this as a button would invite users
  //   to think it's a one-click downgrade — it isn't, Stripe
  //   would still hold them on Pro until period end.
  function planButton(target, current) {
    if (!current) {
      return `<button class="primary" type="button" data-checkout="${target}">Choose ${planLabel(target)}</button>`;
    }
    if (current === target) {
      return `<button class="primary" type="button" disabled>Current plan</button>`;
    }
    if (current === "core" && target === "pro") {
      return `<button class="primary" type="button" data-switch="pro">Upgrade to Pro</button>`;
    }
    // current === "pro", target === "core" → no button.
    return `<p class="muted" style="margin: 0; font-size: 13px;">Pro members stay on Pro for the year. Cancel from <a href="/billing" data-route>Billing</a> if you want to step down at renewal.</p>`;
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
    // `body.plan` is "core" / "pro" mirrored from the most recent
    // Stripe webhook — but it's set on register too (status starts
    // at "unsubscribed" with plan="core" pre-populated so the row
    // is queryable). Only treat the plan as the user's "current"
    // when the subscription is entitled — otherwise Core shows as
    // "Current plan" with the checkout button disabled, blocking
    // the user from ever paying.
    const entitled = body && (body.status === "active" || body.status === "trialing");
    const current = entitled ? body.plan : null;

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
          ${raw(planButton("core", current))}
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
          ${raw(planButton("pro", current))}
        </div>
      </div>

      <p class="muted">
        ${current
          ? "Switching tier opens the Stripe Customer Portal. Stripe prorates upgrades (you pay the difference for the time remaining) and credits downgrades against your next renewal."
          : "Checkout opens Stripe. We never see your card — Hexis only stores the subscription status mirrored back via webhook."}
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
          msg.innerHTML = html`
            You're on Hexis ${planLabel(body.plan)}.
            ${raw(openAppCta("billing", "Open Hexis app"))}
          `;
        }
        if (!fromApp()) {
          setTimeout(() => navigate("/billing", { replace: true }), 700);
        }
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

  async function doSwitch(plan) {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }
    const { status, body } = await apiFetch("/billing/switch", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
    if (status === 200 && body && body.portal_url) {
      window.location.href = body.portal_url;
      return;
    }
    if (body && body.error === "no_active_subscription") {
      alert("Your subscription isn't active yet — refresh and try Choose " + planLabel(plan) + ".");
      return;
    }
    alert("Couldn't open the Customer Portal. Please try again.");
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

      // If the user came from the Hexis app, surface an
      // "Open Hexis app" link so they don't have to alt-tab back.
      if (fromApp()) {
        const cta = document.createElement("div");
        cta.innerHTML = openAppCta("api-keys", "Open Hexis app");
        reveal.appendChild(cta.firstElementChild || cta);
      }
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

      if (fromApp()) {
        const cta = document.createElement("div");
        cta.innerHTML = openAppCta("bots", "Open Hexis app");
        reveal.appendChild(cta.firstElementChild || cta);
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

  // ── /gift — pack picker ──────────────────────────────────────────

  const giftState = {
    packs5: 0,
    packs10: 0,
    bundle: false,         // include own subscription renewal
    bundlePlan: "core",
  };

  function renderGift() {
    if (!state.user) {
      return renderGiftSignedOut();
    }

    setView(html`
      ${raw(pageHeader("Gift codes", "Buy a pack to onboard friends."))}
      <div class="plan-grid">
        ${raw(packPickerCardHtml(5, giftState.packs5))}
        ${raw(packPickerCardHtml(10, giftState.packs10))}
      </div>

      <div class="bundle-toggle">
        <label class="scope-check">
          <input type="checkbox" id="gift-bundle" ${giftState.bundle ? "checked" : ""} />
          <span>Also renew my own plan for another year</span>
        </label>
        <div class="bundle-plan-picker" id="bundle-plan-picker" ${
          giftState.bundle ? "" : 'hidden'
        }>
          <label class="scope-check">
            <input type="radio" name="bundle-plan" value="core" ${
              giftState.bundlePlan === "core" ? "checked" : ""
            } />
            <span>Core · $12/yr</span>
          </label>
          <label class="scope-check">
            <input type="radio" name="bundle-plan" value="pro" ${
              giftState.bundlePlan === "pro" ? "checked" : ""
            } />
            <span>Pro · $50/yr</span>
          </label>
        </div>
      </div>

      <div class="gift-summary">
        <div>
          <div class="muted-label">Total today</div>
          <div class="gift-total" id="gift-total">$0</div>
          <div class="muted" id="gift-total-sub">
            ${giftState.packs5 * 5 + giftState.packs10 * 10} codes
          </div>
        </div>
        <button class="primary" type="button" id="gift-checkout" ${
          giftState.packs5 + giftState.packs10 === 0 ? "disabled" : ""
        }>
          Continue to Checkout
        </button>
      </div>

      ${raw(
        placeholderCard(
          "How redemption works",
          "Each code lets a brand-new friend create an account with the first year of Core prepaid. After year one, their card on file auto-renews at $12/yr — cancellable from their account. Redemption is account-creation-only; existing accounts can't apply codes."
        )
      )}
    `);

    refreshGiftTotal();
  }

  function packPickerCardHtml(size, qty) {
    const isPro = size === 10;
    const price = size === 5 ? "$50" : "$80";
    const perCode = size === 5 ? "$10" : "$8";
    return `
      <div class="plan-card ${isPro ? "plan-card-pro" : ""}" data-pack="${size}">
        <div class="plan-head">
          <h2>${size}-pack</h2>
          <div class="plan-price">${price}<span> one-time</span></div>
        </div>
        <p class="plan-sub">${perCode} / code · ${size} one-year Core invites</p>
        <div class="qty-row">
          <button class="ghost" type="button" data-qty="${size}" data-delta="-1">−</button>
          <span class="qty-value" data-qty-value="${size}">${qty}</span>
          <button class="ghost" type="button" data-qty="${size}" data-delta="1">+</button>
        </div>
      </div>`;
  }

  // ── /gift signed-out — pack-at-signup pre-account flow ──────────

  function renderGiftSignedOut() {
    setView(html`
      ${raw(pageHeader("Start with a gift pack", "Pick a pack and create your Hexis account in one step."))}

      <div class="signed-out-gift">
        <div class="plan-grid">
          <div class="plan-card pack-pick" data-pack-size="5" id="pack-pick-5">
            <div class="plan-head">
              <h2>5-pack</h2>
              <div class="plan-price">$50<span> one-time</span></div>
            </div>
            <p class="plan-sub">One code prepays your year of Core. The other 4 are yours to give away.</p>
          </div>
          <div class="plan-card plan-card-pro pack-pick" data-pack-size="10" id="pack-pick-10">
            <div class="plan-head">
              <h2>10-pack</h2>
              <div class="plan-price">$80<span> one-time</span></div>
            </div>
            <p class="plan-sub">One code prepays your year of Core. The other 9 are yours to give away.</p>
          </div>
        </div>

        <div class="redeem-card" id="pack-signup-form">
          <h3>Create your Hexis account</h3>
          <p class="muted" id="pack-signup-pack">Pick a pack above to continue.</p>

          <label for="pack-username">Username</label>
          <input type="text" id="pack-username" autocapitalize="none" autocorrect="off" spellcheck="false" required />

          <label for="pack-password">Password</label>
          <input type="password" id="pack-password" required />

          <label for="pack-display">Display name (optional)</label>
          <input type="text" id="pack-display" />

          <label for="pack-country">Country</label>
          <select id="pack-country" required>
            ${raw(countryOptionsHtml())}
          </select>

          <button class="primary" type="button" id="pack-submit" disabled>Continue to Checkout</button>
          <p class="muted">
            We'll redirect you to Stripe to pay; one of the codes
            in your pack auto-redeems for your year of Core.
          </p>
          <p class="signin-error" id="pack-error" hidden></p>
        </div>

        <p class="muted">
          Already have an account? <a href="#" data-landing-signin>Sign in</a> to buy packs from the dashboard instead.
        </p>
      </div>
    `);
  }

  let pickedPackSize = null;
  function pickPackSizeForSignup(size) {
    pickedPackSize = size;

    document.querySelectorAll(".pack-pick").forEach((el) => {
      el.classList.toggle("plan-card-active", el.getAttribute("data-pack-size") === String(size));
    });

    const lbl = $("pack-signup-pack");
    if (lbl) {
      lbl.textContent =
        size === 5
          ? "5-pack — one code activates your account, four to give away."
          : "10-pack — one code activates your account, nine to give away.";
    }

    const btn = $("pack-submit");
    if (btn) btn.disabled = !size;
  }

  async function doPackAtSignupSubmit() {
    const errEl = $("pack-error");
    if (errEl) errEl.hidden = true;

    if (!pickedPackSize) {
      showPackError("Pick a pack first.");
      return;
    }

    const username = ($("pack-username") || {}).value || "";
    const password = ($("pack-password") || {}).value || "";
    const display_name = ($("pack-display") || {}).value || "";
    const country = ($("pack-country") || {}).value || "";

    if (!username || !password) {
      showPackError("Username + password are required.");
      return;
    }
    if (!country) {
      showPackError("Please pick your country.");
      return;
    }

    const ikBuf = new Uint8Array(32);
    crypto.getRandomValues(ikBuf);
    const identity_key = btoa(String.fromCharCode(...ikBuf));

    const { status, body } = await apiFetch("/billing/gifts/purchase-at-signup", {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        display_name: display_name || null,
        identity_key,
        country,
        pack_size: pickedPackSize,
      }),
    });

    if (status === 202 && body && body.identity_required) {
      window.location.href = body.verification_url;
      return;
    }

    if (status === 200 && body && body.checkout_url) {
      window.location.href = body.checkout_url;
      return;
    }

    showPackError(
      status === 422
        ? "That username might already be taken — try another."
        : (body && body.error) || "Couldn't start checkout. Please try again."
    );
  }

  function showPackError(msg) {
    const errEl = $("pack-error");
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
  }

  function refreshGiftTotal() {
    const packsTotal = giftState.packs5 * 50 + giftState.packs10 * 80;
    const subAdd = giftState.bundle ? (giftState.bundlePlan === "pro" ? 50 : 12) : 0;
    const total = packsTotal + subAdd;

    const el = $("gift-total");
    if (el) el.textContent = "$" + total;

    const subEl = $("gift-total-sub");
    if (subEl) {
      const codes = giftState.packs5 * 5 + giftState.packs10 * 10;
      const recurring = giftState.bundle ? (giftState.bundlePlan === "pro" ? 50 : 12) : 0;
      subEl.textContent =
        recurring > 0
          ? `${codes} codes · then $${recurring}/yr recurring`
          : `${codes} codes`;
    }

    const btn = $("gift-checkout");
    if (btn) btn.disabled = giftState.packs5 + giftState.packs10 === 0;

    const picker = $("bundle-plan-picker");
    if (picker) picker.hidden = !giftState.bundle;
  }

  async function doGiftCheckout() {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }

    const packs = [];
    if (giftState.packs5 > 0) packs.push({ size: 5, qty: giftState.packs5 });
    if (giftState.packs10 > 0) packs.push({ size: 10, qty: giftState.packs10 });

    const payload = { packs };
    if (giftState.bundle) {
      payload.include_self_sub = { plan: giftState.bundlePlan };
    }

    const { status, body } = await apiFetch("/billing/gifts/purchase", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (status === 200 && body && body.checkout_url) {
      window.location.href = body.checkout_url;
      return;
    }

    alert("Couldn't start Stripe checkout. Please try again.");
  }

  // ── /gift/orders — past purchases + per-code revoke ──────────────

  async function renderGiftOrders() {
    setView(html`
      ${raw(pageHeader("Past gift orders", "Codes from packs you've purchased."))}
      <div id="gift-orders-body"><p class="muted">Loading…</p></div>
    `);

    const { status, body } = await apiFetch("/api/v1/billing/gifts/orders");
    const root = $("gift-orders-body");
    if (!root) return;

    if (status !== 200 || !body || !body.ok) {
      root.innerHTML = `<p class="error">Couldn't load your orders.</p>`;
      return;
    }

    const orders = body.orders || [];
    if (orders.length === 0) {
      root.innerHTML = html`
        <div class="soon-card">
          <div class="soon-card-head"><h2>No orders yet</h2></div>
          <p>Once you buy a gift pack from the Gift codes page, your codes will appear here.</p>
        </div>
      `;
      return;
    }

    root.innerHTML = orders.map(orderCard).join("");
  }

  function orderCard(order) {
    const codes = (order.codes || []).map(codeRow).join("");
    return html`
      <div class="order-card">
        <div class="order-head">
          <h3>${order.pack_size}-pack · $${(order.total_amount_cents / 100).toFixed(2)}</h3>
          <span class="muted">${fmtDate(order.paid_at)}</span>
        </div>
        <table class="codes-table">
          <thead>
            <tr><th>Code</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>${raw(codes)}</tbody>
        </table>
      </div>
    `;
  }

  function codeRow(c) {
    const status =
      c.redeemed_at
        ? `<span class="muted">Redeemed ${fmtDate(c.redeemed_at)}</span>`
        : c.revoked_at
        ? `<span class="muted">Revoked</span>`
        : `<span class="muted">Unused — expires ${fmtDate(c.expires_at)}</span>`;

    const action =
      c.redeemed_at || c.revoked_at
        ? ""
        : `<button class="ghost" type="button" data-revoke-code="${c.id}">Revoke</button>`;

    const codeCell = c.redeemed_at || c.revoked_at
      ? `<code class="code-cell muted-cell">${c.code}</code>`
      : `<code class="code-cell">${c.code}</code>`;

    return html`
      <tr>
        <td>${raw(codeCell)}</td>
        <td>${raw(status)}</td>
        <td>${raw(action)}</td>
      </tr>
    `;
  }

  async function doGiftRevoke(codeId) {
    if (!state.csrfToken) {
      alert("Please sign in again to continue.");
      return;
    }
    if (!confirm("Revoke this code? You'll get a partial refund for unused codes.")) return;

    const { status } = await apiFetch("/api/v1/billing/gifts/revoke", {
      method: "POST",
      body: JSON.stringify({ code_id: parseInt(codeId, 10) }),
    });

    if (status === 200) renderGiftOrders();
    else alert("Revoke failed.");
  }

  // ── /redeem — pre-signup account creation ────────────────────────

  async function renderRedeem() {
    const params = new URLSearchParams(location.search);
    const prefill = params.get("code") || "";

    setView(html`
      ${raw(pageHeader("Redeem a gift code", "Create a new Hexis account with a year of Core prepaid."))}

      <div class="redeem-card" id="redeem-step">
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
        <button class="primary" type="button" id="redeem-check">Check code</button>
        <p class="muted">
          Gift codes work only when creating a new account — existing
          accounts can't apply them.
        </p>
        <p class="signin-error" id="redeem-error" hidden></p>
      </div>
    `);

    if (prefill) {
      // Auto-preflight on load.
      doRedeemPreflight(prefill);
    }
  }

  async function doRedeemPreflight(maybeCode) {
    const errEl = $("redeem-error");
    if (errEl) errEl.hidden = true;

    const code = (maybeCode || ($("redeem-code") && $("redeem-code").value) || "").trim();
    if (!code) {
      showRedeemError("Enter a gift code.");
      return;
    }

    const { status, body } = await apiFetch(
      "/api/v1/billing/gifts/preflight?code=" + encodeURIComponent(code)
    );

    if (status === 200 && body && body.ok) {
      showRedeemSignupForm(code);
      return;
    }

    const reason = (body && body.error) || "unknown";
    const msg =
      reason === "expired"
        ? "This code has expired."
        : reason === "redeemed"
        ? "This code has already been redeemed."
        : reason === "revoked"
        ? "This code is no longer valid. Ask the giver for a new one."
        : "We don't recognise that code.";
    showRedeemError(msg);
  }

  function showRedeemError(msg) {
    const errEl = $("redeem-error");
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
  }

  function showRedeemSignupForm(code) {
    const root = $("redeem-step");
    if (!root) return;

    root.innerHTML = html`
      <h3>Create your Hexis account</h3>
      <p class="muted">Code: <code>${code}</code></p>

      <label for="redeem-username">Username</label>
      <input
        type="text"
        id="redeem-username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        required
      />

      <label for="redeem-password">Password</label>
      <input type="password" id="redeem-password" required />

      <label for="redeem-display">Display name (optional)</label>
      <input type="text" id="redeem-display" />

      <label for="redeem-country">Country</label>
      <select id="redeem-country" required>
        ${raw(countryOptionsHtml())}
      </select>
      <p class="muted">
        Some regions require a one-time identity check before
        creating an account. We only keep a cryptographic hash —
        not your documents.
      </p>

      <button class="primary" type="button" id="redeem-submit">Create account</button>
      <p class="muted">
        After this step we'll collect a card so your subscription
        auto-renews at $12/yr in one year. Cancel any time before
        then.
      </p>
      <p class="signin-error" id="redeem-error" hidden></p>
    `;

    root.dataset.code = code;
  }

  // Trim country list — most popular plus the Identity-required
  // ones called out in the spec. Adding more here is operator
  // copy work.
  function countryOptionsHtml() {
    const opts = [
      ["", "Select…"],
      ["US", "United States"],
      ["CA", "Canada"],
      ["MX", "Mexico"],
      ["BR", "Brazil"],
      ["AR", "Argentina"],
      ["GB", "United Kingdom"],
      ["IE", "Ireland"],
      ["FR", "France"],
      ["DE", "Germany"],
      ["NL", "Netherlands"],
      ["ES", "Spain"],
      ["IT", "Italy"],
      ["SE", "Sweden"],
      ["NO", "Norway"],
      ["DK", "Denmark"],
      ["FI", "Finland"],
      ["PL", "Poland"],
      ["TR", "Turkey"],
      ["AU", "Australia"],
      ["NZ", "New Zealand"],
      ["JP", "Japan"],
      ["KR", "South Korea"],
      ["IN", "India"],
      ["SG", "Singapore"],
      ["HK", "Hong Kong"],
      ["ZA", "South Africa"],
    ];
    return opts
      .map(([code, label]) => `<option value="${code}">${label}</option>`)
      .join("");
  }

  async function doRedeemSubmit() {
    const root = $("redeem-step");
    if (!root) return;

    const code = root.dataset.code;
    const username = ($("redeem-username") || {}).value || "";
    const password = ($("redeem-password") || {}).value || "";
    const display_name = ($("redeem-display") || {}).value || "";
    const country = ($("redeem-country") || {}).value || "";

    if (!username || !password) {
      showRedeemError("Username + password are required.");
      return;
    }
    if (!country) {
      showRedeemError("Please pick your country.");
      return;
    }

    const ikBuf = new Uint8Array(32);
    crypto.getRandomValues(ikBuf);
    const identity_key = btoa(String.fromCharCode(...ikBuf));

    const { status, body } = await apiFetch("/auth/web/signup", {
      method: "POST",
      body: JSON.stringify({
        gift_code: code,
        username,
        password,
        display_name: display_name || null,
        identity_key,
        country,
      }),
    });

    // Phase I — Identity-gated regions get bounced through Stripe
    // Identity before the user row is created.
    if (status === 202 && body && body.identity_required) {
      window.location.href = body.verification_url;
      return;
    }

    if (status === 201 && body && body.ok) {
      state.user = body.user;
      state.csrfToken = body.csrf_token;
      await onSignedIn();

      root.innerHTML = html`
        <h3>Account created</h3>
        <p class="muted">Welcome to Hexis, ${body.user.display_name || body.user.username}.</p>
        <p>
          Your gift covers the first year of Core. To finish setup,
          we'll need a card on file before the year is up — head to
          <a href="/billing" data-route>Billing</a> to add one.
        </p>
        <p>
          <a href="/" class="primary" data-route>Open dashboard</a>
        </p>
      `;
      return;
    }

    showRedeemError(
      status === 422
        ? "That username might already be taken — try another."
        : "Couldn't create your account. Please try again."
    );
  }

  // ── /redeem/return — Identity verification poll page ────────────

  async function renderRedeemReturn() {
    const params = new URLSearchParams(location.search);
    const token = params.get("signup_token");

    if (!token) {
      setView(html`
        ${raw(pageHeader("Verification", ""))}
        <p class="error">Missing signup token. Please restart from the redeem link.</p>
      `);
      return;
    }

    setView(html`
      ${raw(pageHeader("Finishing verification", "Just a moment — we're checking the result."))}
      <div id="identity-body">
        <p class="muted">Waiting for Stripe…</p>
      </div>
    `);

    await pollIdentity(token);
  }

  async function pollIdentity(token) {
    const startedAt = Date.now();
    const root = $("identity-body");

    while (Date.now() - startedAt < 60_000) {
      const { status, body } = await apiFetch(
        "/api/v1/identity/status?signup_token=" + encodeURIComponent(token)
      );

      if (status === 200 && body && body.status) {
        switch (body.status) {
          case "verified":
            // Pack-at-signup flows produce a Stripe Checkout URL
            // post-Identity — navigate the user to it now so
            // they can pay for the pack.
            if (body.checkout_url) {
              window.location.href = body.checkout_url;
              return;
            }

            if (root) {
              root.innerHTML = html`
                <p>Verified. Your account is ready —
                <a href="/" class="primary" data-route>open the dashboard</a>.</p>
              `;
            }
            return;

          case "blocked_under_18":
            if (root) {
              root.innerHTML = `
                <div class="oauth-error">
                  <h2>We can't create an account for you at this time.</h2>
                </div>`;
            }
            return;

          case "account_exists":
            if (root) {
              root.innerHTML = `
                <div class="oauth-error">
                  <h2>An account with this identity already exists.</h2>
                  <p>Sign in to your existing account instead.</p>
                </div>`;
            }
            return;

          case "failed":
            if (root) {
              root.innerHTML = `
                <div class="oauth-error">
                  <h2>Verification failed.</h2>
                  <p><a href="/redeem">Try again</a> or contact support.</p>
                </div>`;
            }
            return;

          case "requires_input":
            if (root) {
              root.innerHTML = `
                <div class="oauth-error">
                  <h2>Stripe needs another attempt.</h2>
                  <p><a href="/redeem">Restart the redeem flow</a> to retry.</p>
                </div>`;
            }
            return;

          // pending → keep polling
        }
      } else if (status === 410) {
        if (root) {
          root.innerHTML = `
            <div class="oauth-error">
              <h2>Verification window expired.</h2>
              <p><a href="/redeem">Restart the redeem flow</a> to try again.</p>
            </div>`;
        }
        return;
      }

      await sleep(2000);
    }

    if (root) {
      root.innerHTML = `
        <p class="muted">Still waiting on Stripe.
        <a href="/redeem/return?signup_token=${token}" data-route>Refresh</a>
        in a moment.</p>`;
    }
  }

  function render404() {
    setView(html`
      ${raw(pageHeader("Not found", "That page doesn't exist."))}
      <p>
        <a href="/" data-route>Back to the dashboard</a>
      </p>
    `);
  }

  // ── /oauth/authorize ─────────────────────────────────────────────
  // Consent screen for third-party OAuth 2.1 + PKCE bots. The bot
  // sends the user here with all the authorize-request params; we
  // preflight, render "App X wants permission to: …", then on
  // Allow / Deny POST to the backend which returns the redirect
  // URL (we never auto-redirect to an unverified URI).

  async function renderOauthAuthorize() {
    setView(html`
      <section class="page-header">
        <h1>Authorize app</h1>
        <p class="lede">An external application is requesting access to your Hexis account.</p>
      </section>
      <div id="oauth-body">
        <p class="muted">Validating request…</p>
      </div>
    `);

    const qp = new URLSearchParams(location.search);
    const params = {};
    for (const k of [
      "client_id",
      "redirect_uri",
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "state",
    ]) {
      const v = qp.get(k);
      if (v !== null) params[k] = v;
    }

    const preflightQS = new URLSearchParams(params).toString();
    const { status, body } = await apiFetch(
      "/oauth/authorize/preflight?" + preflightQS
    );

    const bodyEl = $("oauth-body");
    if (!bodyEl) return;

    if (status !== 200 || !body || !body.ok) {
      const reason = (body && body.error) || "invalid_request";
      bodyEl.innerHTML = html`
        <div class="oauth-error">
          <h2>This authorization request can't be completed.</h2>
          <p>The bot that sent you here is misconfigured or has not been approved.</p>
          <p class="muted">Error code: <code>${reason}</code></p>
        </div>
      `;
      return;
    }

    const app = body.app;
    const scopes = body.requested_scopes || [];

    if (!state.user) {
      bodyEl.innerHTML = html`
        <div class="oauth-card">
          <div class="oauth-app-head">
            <div class="oauth-app-name">${app.name}</div>
            <div class="muted">${app.description || ""}</div>
          </div>
          <p>
            Sign in to your Hexis account to review what
            <strong>${app.name}</strong> is asking for.
          </p>
          <button class="primary" type="button" id="oauth-signin">Sign in to continue</button>
        </div>
      `;
      const btn = $("oauth-signin");
      if (btn) btn.addEventListener("click", () => openDialog());
      return;
    }

    const scopeList = scopes
      .map((s) => `<li><code>${s}</code> — ${scopeDescription(s)}</li>`)
      .join("");

    const clientType = app.is_public_client
      ? "public client (no secret; PKCE-only)"
      : "confidential client";

    bodyEl.innerHTML = html`
      <div class="oauth-card">
        <div class="oauth-app-head">
          <div class="oauth-app-name">${app.name}</div>
          ${app.description
            ? html`<div class="muted">${app.description}</div>`
            : ""}
          ${app.homepage_url
            ? html`<div><a href="${app.homepage_url}" rel="noopener noreferrer" target="_blank">${app.homepage_url}</a></div>`
            : ""}
          <div class="muted oauth-app-type">${clientType}</div>
        </div>

        <h2 class="oauth-section">Wants permission to:</h2>
        <ul class="oauth-scopes">${raw(scopeList)}</ul>

        <p class="muted oauth-fine">
          Authorizing grants <strong>${app.name}</strong> access to act
          on your account using only the scopes above. You can revoke
          this access at any time from <a href="/bots" data-route>Bots</a>.
        </p>

        <div class="oauth-actions">
          <button class="ghost" type="button" id="oauth-deny">Cancel</button>
          <button class="primary" type="button" id="oauth-allow">Authorize</button>
        </div>

        <p class="muted oauth-fine" id="oauth-status" hidden></p>
      </div>
    `;

    $("oauth-allow").addEventListener("click", () => doOauthDecision("allow", params));
    $("oauth-deny").addEventListener("click", () => doOauthDecision("deny", params));
  }

  async function doOauthDecision(decision, params) {
    if (!state.csrfToken) {
      const status = $("oauth-status");
      if (status) {
        status.textContent = "Please sign in again to continue.";
        status.hidden = false;
      }
      return;
    }

    const status = $("oauth-status");
    if (status) {
      status.textContent =
        decision === "allow" ? "Issuing authorization…" : "Cancelling…";
      status.hidden = false;
    }

    const path =
      decision === "allow"
        ? "/oauth/authorize/confirm"
        : "/oauth/authorize/deny";

    const { status: code, body } = await apiFetch(path, {
      method: "POST",
      body: JSON.stringify(params),
    });

    if (code === 200 && body && body.ok && body.redirect_url) {
      // Navigate to the bot's redirect_uri (external).
      window.location.href = body.redirect_url;
      return;
    }

    if (status) {
      status.textContent =
        (body && body.error) || "Couldn't complete the request.";
      status.hidden = false;
    }
  }

  function scopeDescription(scope) {
    const map = {
      "read:messages": "read messages in your servers + DMs",
      "write:messages": "send messages on your behalf",
      "read:servers": "see the servers you're in",
      "manage:roles": "create + assign roles in your servers",
      "manage:channels": "create + edit channels in your servers",
      "read:voice": "join voice channels you can access",
      "write:voice": "transmit in voice channels",
      "read:dms": "read DMs the bot is messaged in",
      "write:dms": "send DMs to users who message it",
    };
    return map[scope] || scope;
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
      // Phase J — backend reissues a CSRF token on /me so the SPA
      // can recover its in-memory token after a page reload.
      if (body.csrf_token) state.csrfToken = body.csrf_token;
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

  // Close the sign-in dialog before navigating away when the user
  // clicks "Forgot password?" or "Create one" inside it.
  document.addEventListener("click", (e) => {
    if (e.target.closest("#signin-forgot") || e.target.closest("#signin-register")) {
      try { document.getElementById("signin-dialog")?.close(); } catch {}
    }
  });

  // Plan checkout buttons on /subscription.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-checkout]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const plan = btn.getAttribute("data-checkout");
    doCheckout(plan);
  });

  // Plan-switch buttons on /subscription (active subscriber
  // changing tier — opens Stripe Customer Portal w/ subscription
  // update pre-targeted, Stripe handles proration).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-switch]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const plan = btn.getAttribute("data-switch");
    doSwitch(plan);
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

  // /gift pack qty +/-
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-qty][data-delta]");
    if (!btn) return;
    e.preventDefault();
    const size = parseInt(btn.getAttribute("data-qty"), 10);
    const delta = parseInt(btn.getAttribute("data-delta"), 10);

    if (size === 5) giftState.packs5 = Math.max(0, giftState.packs5 + delta);
    if (size === 10) giftState.packs10 = Math.max(0, giftState.packs10 + delta);

    const valueEl = document.querySelector(`[data-qty-value="${size}"]`);
    if (valueEl) {
      valueEl.textContent = size === 5 ? giftState.packs5 : giftState.packs10;
    }
    refreshGiftTotal();
  });

  // /gift checkout button
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#gift-checkout");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    doGiftCheckout();
  });

  // /gift/orders revoke per-code
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-revoke-code]");
    if (!btn) return;
    e.preventDefault();
    doGiftRevoke(btn.getAttribute("data-revoke-code"));
  });

  // /redeem flow
  document.addEventListener("click", (e) => {
    if (e.target.closest("#redeem-check")) {
      e.preventDefault();
      doRedeemPreflight();
      return;
    }
    if (e.target.closest("#redeem-submit")) {
      e.preventDefault();
      doRedeemSubmit();
      return;
    }
  });

  // /gift bundle toggle + plan radios.
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === "gift-bundle") {
      giftState.bundle = !!e.target.checked;
      refreshGiftTotal();
      return;
    }

    if (e.target && e.target.name === "bundle-plan") {
      giftState.bundlePlan = e.target.value === "pro" ? "pro" : "core";
      refreshGiftTotal();
      return;
    }
  });

  // /gift signed-out — pack-at-signup pack picker.
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".pack-pick[data-pack-size]");
    if (!card) return;
    e.preventDefault();
    pickPackSizeForSignup(parseInt(card.getAttribute("data-pack-size"), 10));
  });

  // /gift signed-out — submit button on the pack-at-signup form.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#pack-submit");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    doPackAtSignupSubmit();
  });

  window.addEventListener("popstate", render);

  // ── Phase J5 — browser register + onboarding ───────────────────

  function renderRegister() {
    setView(html`
      ${raw(pageHeader("Create your Hexis account", "Pick a username, set a password, and verify your email."))}

      <div class="redeem-card" id="register-step">
        <label for="reg-username">Username</label>
        <input type="text" id="reg-username" autocapitalize="none" autocorrect="off"
               spellcheck="false" pattern="[a-zA-Z0-9_.\\-]{2,32}" required />

        <label for="reg-email">Email</label>
        <input type="email" id="reg-email" autocomplete="email" required />

        <label for="reg-password">Password (8+ characters)</label>
        <input type="password" id="reg-password" minlength="8" autocomplete="new-password" required />

        <label for="reg-password2">Confirm password</label>
        <input type="password" id="reg-password2" minlength="8" autocomplete="new-password" required />

        <button class="primary" type="button" id="register-submit">Create account</button>

        <p class="muted">
          We'll email you a verification link, then walk you through setting up
          two-factor auth.
        </p>
        <p class="signin-error" id="register-error" hidden></p>
      </div>
    `);
  }

  async function doRegisterSubmit() {
    const errEl = $("register-error");
    if (errEl) errEl.hidden = true;
    const submit = $("register-submit");
    if (submit) { submit.disabled = true; submit.textContent = "Creating…"; }

    const username = $("reg-username").value.trim();
    const email = $("reg-email").value.trim();
    const password = $("reg-password").value;
    const password2 = $("reg-password2").value;

    function fail(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      if (submit) { submit.disabled = false; submit.textContent = "Create account"; }
    }

    if (password !== password2) return fail("Passwords don't match.");
    if (password.length < 8) return fail("Password must be at least 8 characters.");

    let keys;
    try {
      const mod = await import("/keys.js");
      keys = await mod.generateAccountKeys(password);
    } catch (e) {
      return fail("Couldn't generate cryptographic keys: " + e.message);
    }

    const { status, body } = await apiFetch("/auth/web/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        email,
        password,
        identity_key: keys.identity_key_b64,
        mlkem_ek: keys.mlkem_ek_b64,
      }),
    });

    if (status === 201 && body && body.ok) {
      state.user = body.user;
      state.csrfToken = body.csrf_token;
      // Per phase J6.5, post-register lands on /setup-2fa.
      navigate("/setup-2fa", { replace: true });
      return;
    }

    const reason = (body && body.error) || "unknown";
    if (reason === "username_taken") return fail("That username is already taken.");
    if (reason === "email_taken") return fail("That email is already in use.");
    if (reason === "bad_identity_key") return fail("Couldn't generate a valid identity key.");
    fail("Couldn't create the account. Try again or contact support.");
  }

  function renderWelcome() {
    const params = new URLSearchParams(location.search);
    const fromDesktop = params.get("from") === "desktop";

    const cards = `
      <div class="plan-grid">
        <div class="plan-card pack-pick" id="welcome-pay">
          <div class="plan-head">
            <h2>Pay for a plan</h2>
            <div class="plan-price">$12+<span> / year</span></div>
          </div>
          <p class="plan-sub">Core or Pro — billed via Stripe. Cancel anytime.</p>
        </div>
        <div class="plan-card pack-pick" id="welcome-redeem">
          <div class="plan-head">
            <h2>Redeem a gift code</h2>
            <div class="plan-price">free<span> for you</span></div>
          </div>
          <p class="plan-sub">Got a code from a friend? It prepays your year of Core.</p>
        </div>
        <div class="plan-card plan-card-pro pack-pick" id="welcome-squad">
          <div class="plan-head">
            <h2>Move your Squad</h2>
            <div class="plan-price">$50+<span> one-time</span></div>
          </div>
          <p class="plan-sub">Buy a 5- or 10-pack — one code redeems for you, the rest are yours to give away.</p>
        </div>
      </div>`;

    const continueDesktop = fromDesktop
      ? `<p style="margin-top: 2rem;"><a class="primary" href="hexis://login?email=${encodeURIComponent(state.user?.email || "")}">Continue in Hexis (desktop)</a></p>`
      : "";

    setView(html`
      ${raw(pageHeader("You're in. Pick how to get started.", "All three options unlock the full Hexis experience — choose what fits."))}
      ${raw(cards + continueDesktop)}
    `);
  }

  function renderVerifyEmailDone() {
    setView(html`
      ${raw(pageHeader("Email verified", "Your Hexis email is now confirmed."))}

      <div class="redeem-card">
        <p>Thanks — your email is on file. You can close this tab, or
        <a href="/welcome" data-route>continue setting up your account</a>.</p>
      </div>
    `);
  }

  function renderForgotPassword() {
    setView(html`
      ${raw(pageHeader("Forgot your password?", "Enter your email and we'll send a reset link."))}

      <div class="redeem-card" id="forgot-step">
        <label for="forgot-email">Email</label>
        <input type="email" id="forgot-email" autocomplete="email" required />

        <button class="primary" type="button" id="forgot-submit">Send reset link</button>
        <p class="muted">If the email is on file, a reset link is on its way.</p>
        <p class="signin-error" id="forgot-error" hidden></p>
      </div>
    `);
  }

  async function doForgotSubmit() {
    const submit = $("forgot-submit");
    if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }

    const email = $("forgot-email").value.trim();
    if (!email) {
      if (submit) { submit.disabled = false; submit.textContent = "Send reset link"; }
      return;
    }

    await apiFetch("/auth/web/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    });

    // Always 200 (anti-enumeration). Show a confirmation regardless.
    const root = $("forgot-step");
    if (root) {
      root.innerHTML = html`
        <h3>Check your inbox</h3>
        <p>If <strong>${email}</strong> is on file, a reset link is on its way.</p>
        <p class="muted">The link is valid for 1 hour. Didn't get it? Check spam or
        <a href="/forgot-password" data-route>try again</a>.</p>
      `;
    }
  }

  function renderResetPassword() {
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";

    if (!token) {
      setView(html`
        ${raw(pageHeader("Reset link expired", "That link is missing the reset token."))}
        <div class="redeem-card">
          <p><a href="/forgot-password" data-route>Request a new link.</a></p>
        </div>
      `);
      return;
    }

    setView(html`
      ${raw(pageHeader("Choose a new password", "Set the password you'll use to sign in."))}

      <div class="redeem-card" id="reset-step">
        <label for="reset-password">New password (8+ characters)</label>
        <input type="password" id="reset-password" minlength="8" autocomplete="new-password" required />

        <label for="reset-password2">Confirm new password</label>
        <input type="password" id="reset-password2" minlength="8" autocomplete="new-password" required />

        <div id="reset-totp-row" hidden>
          <label for="reset-totp">Two-factor code (or backup code)</label>
          <input type="text" id="reset-totp" autocomplete="off" />
          <p class="muted">2FA is on for this account — enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
        </div>

        <button class="primary" type="button" id="reset-submit" data-token="${token}">Set new password</button>
        <p class="signin-error" id="reset-error" hidden></p>
      </div>
    `);
  }

  async function doResetSubmit() {
    const errEl = $("reset-error");
    if (errEl) errEl.hidden = true;
    const submit = $("reset-submit");
    if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }

    function fail(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      if (submit) { submit.disabled = false; submit.textContent = "Set new password"; }
    }

    const token = submit && submit.getAttribute("data-token");
    const pw1 = $("reset-password").value;
    const pw2 = $("reset-password2").value;
    const totp = $("reset-totp") && $("reset-totp").value.trim();

    if (pw1 !== pw2) return fail("Passwords don't match.");
    if (pw1.length < 8) return fail("Password must be at least 8 characters.");

    const payload = { token, new_password: pw1 };
    if (totp) payload.totp_code = totp;

    const { status, body } = await apiFetch("/auth/web/password/reset", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (status === 200 && body && body.ok) {
      setView(html`
        ${raw(pageHeader("Password updated", "You can sign in with your new password."))}
        <div class="redeem-card">
          <p>All set. <a href="/" data-route>Back to the dashboard.</a></p>
        </div>
      `);
      return;
    }

    const reason = (body && body.error) || "";
    if (reason === "totp_required") {
      const row = $("reset-totp-row");
      if (row) row.hidden = false;
      return fail("Enter your two-factor code below.");
    }
    if (reason === "invalid_totp_code") return fail("That two-factor code didn't match.");
    if (reason === "weak_password") return fail("Password too short.");
    if (reason === "expired") return fail("That reset link has expired. Request a new one.");
    if (reason === "consumed" || reason === "invalid_token") return fail("That reset link is no longer valid.");
    fail("Couldn't reset the password. Try again.");
  }

  function renderSetupTotp() {
    setView(html`
      ${raw(pageHeader("Set up two-factor authentication", "Required to keep your account safe. Takes about 30 seconds."))}

      <div class="redeem-card" id="setup2fa-step">
        <p>Open an authenticator app (Google Authenticator, 1Password, Authy, …)
        and either scan the QR or paste the secret.</p>

        <div id="setup2fa-qr" style="margin: 1rem 0; min-height: 200px;"></div>

        <label class="muted-label">Secret (manual entry)</label>
        <pre class="muted" id="setup2fa-secret" style="word-break: break-all; padding: 0.5rem; border: 1px solid var(--border); border-radius: 4px;"></pre>

        <label for="totp-code">6-digit code from your app</label>
        <input type="text" id="totp-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
               autocomplete="one-time-code" autocorrect="off" />

        <button class="primary" type="button" id="totp-confirm">Confirm + enable</button>
        <p class="signin-error" id="totp-error" hidden></p>
      </div>
    `);

    bootSetupTotp();
  }

  async function bootSetupTotp() {
    const { status, body } = await apiFetch("/api/v1/account/totp/setup", {
      method: "POST",
      body: "{}",
    });

    if (status !== 200 || !body || !body.ok) {
      const errEl = $("totp-error");
      if (errEl) {
        errEl.textContent = (body && body.error === "already_enrolled")
          ? "Two-factor is already set up on this account."
          : "Couldn't start 2FA setup. Try again.";
        errEl.hidden = false;
      }
      return;
    }

    const secret = $("setup2fa-secret");
    if (secret) secret.textContent = body.secret_b32;

    const qrTarget = $("setup2fa-qr");
    if (qrTarget) {
      try {
        const mod = await import("/vendor/qr.js");
        qrTarget.innerHTML = mod.svg(body.otpauth_uri);
      } catch (_) {
        qrTarget.innerHTML = `<a href="${body.otpauth_uri}">Tap to open in auth app</a>`;
      }
    }

    const btn = $("totp-confirm");
    if (btn) btn.setAttribute("data-secret", body.secret);
  }

  async function doConfirmTotp() {
    const errEl = $("totp-error");
    if (errEl) errEl.hidden = true;
    const btn = $("totp-confirm");
    if (btn) { btn.disabled = true; btn.textContent = "Confirming…"; }

    const secret = btn && btn.getAttribute("data-secret");
    const code = ($("totp-code") && $("totp-code").value || "").trim();

    function fail(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      if (btn) { btn.disabled = false; btn.textContent = "Confirm + enable"; }
    }

    if (!/^\d{6}$/.test(code)) return fail("Enter the 6-digit code from your auth app.");

    const { status, body } = await apiFetch("/api/v1/account/totp/enroll", {
      method: "POST",
      body: JSON.stringify({ secret, code }),
    });

    if (status === 200 && body && body.ok && Array.isArray(body.backup_codes)) {
      renderBackupCodes(body.backup_codes);
      return;
    }

    if (body && body.error === "invalid_code") return fail("That code didn't match. Check the time on your device and try again.");
    fail("Couldn't enroll. Try again.");
  }

  function renderBackupCodes(codes) {
    setView(html`
      ${raw(pageHeader("Save your backup codes", "Each code is single-use and lets you sign in if you lose your auth app."))}

      <div class="redeem-card">
        <ol class="backup-list" style="font-family: monospace; line-height: 1.8; columns: 2; padding-left: 1.5rem;">
          ${raw(codes.map((c) => `<li>${escape(c)}</li>`).join(""))}
        </ol>
        <p class="muted">Print, screenshot, or save these somewhere offline. We won't show them again.</p>
        <button class="primary" type="button" id="backup-confirm">I've saved them</button>
      </div>
    `);
  }

  // ── Phase J5b — Move-your-Squad ────────────────────────────────

  function renderMoveSquad() {
    setView(html`
      ${raw(pageHeader("Move your Squad", "Pick a pack — one code activates your year of Core, the rest are yours to give away."))}

      <div class="plan-grid">
        <div class="plan-card pack-pick" data-squad-pack="5">
          <div class="plan-head">
            <h2>5-pack</h2>
            <div class="plan-price">$50<span> one-time</span></div>
          </div>
          <p class="plan-sub">$10 / code · 4 invites to give away.</p>
        </div>
        <div class="plan-card plan-card-pro pack-pick" data-squad-pack="10">
          <div class="plan-head">
            <h2>10-pack</h2>
            <div class="plan-price">$80<span> one-time</span></div>
          </div>
          <p class="plan-sub">$8 / code · 9 invites to give away.</p>
        </div>
      </div>

      <p class="muted">
        We'll redirect you to Stripe to pay. After checkout, your year of
        Core activates and the remaining codes show up on
        <a href="/gift/orders" data-route>past orders</a>.
      </p>
      <p class="signin-error" id="move-squad-error" hidden></p>
    `);
  }

  async function doMoveSquadCheckout(packSize) {
    const errEl = $("move-squad-error");
    if (errEl) errEl.hidden = true;

    const { status, body } = await apiFetch("/billing/gifts/purchase-self-redeem", {
      method: "POST",
      body: JSON.stringify({ pack_size: packSize }),
    });

    if (status === 200 && body && body.checkout_url) {
      window.location.href = body.checkout_url;
      return;
    }

    if (errEl) {
      errEl.textContent =
        (body && body.error === "stripe_unreachable")
          ? "Stripe is unreachable — try again in a moment."
          : "Couldn't start checkout. Try again.";
      errEl.hidden = false;
    }
  }

  // ── TOTP modal for sign-in challenge + step-up step ─────────────

  let pendingTotp = null;

  function showTotpModal({ title, description, onSubmit }) {
    pendingTotp = { onSubmit };

    let modal = document.getElementById("totp-modal");
    if (!modal) {
      modal = document.createElement("dialog");
      modal.id = "totp-modal";
      modal.className = "signin-dialog totp-modal";
      modal.innerHTML = `
        <form method="dialog">
          <header>
            <h3 id="totp-modal-title"></h3>
          </header>
          <p id="totp-modal-desc"></p>
          <label for="totp-modal-input">6-digit code</label>
          <input id="totp-modal-input" type="text" inputmode="numeric" pattern="[0-9]{6}"
                 maxlength="20" autocomplete="one-time-code" autocorrect="off" />
          <p class="signin-error" id="totp-modal-error" hidden></p>
          <div class="signin-actions">
            <button type="button" class="ghost" id="totp-modal-cancel">Cancel</button>
            <button type="button" class="primary" id="totp-modal-submit">Verify</button>
          </div>
        </form>
      `;
      document.body.appendChild(modal);

      $("totp-modal-cancel").addEventListener("click", () => modal.close());
      $("totp-modal-submit").addEventListener("click", async () => {
        const code = ($("totp-modal-input").value || "").trim();
        if (pendingTotp && pendingTotp.onSubmit) {
          const ok = await pendingTotp.onSubmit(code);
          if (ok) modal.close();
          else {
            const e = $("totp-modal-error");
            if (e) { e.textContent = "Code didn't match. Try again."; e.hidden = false; }
          }
        }
      });
    }

    $("totp-modal-title").textContent = title;
    $("totp-modal-desc").textContent = description;
    $("totp-modal-input").value = "";
    const errEl = $("totp-modal-error");
    if (errEl) errEl.hidden = true;
    modal.showModal();
  }

  // Sign-in second leg: exchange `challenge_token` + 6-digit code
  // (or backup code) for a session cookie, then complete login.
  async function promptTotpForLogin(challengeToken) {
    return new Promise((resolve) => {
      showTotpModal({
        title: "Two-factor required",
        description: "Enter the 6-digit code from your authenticator app, or one of your backup codes.",
        onSubmit: async (code) => {
          const { status, body } = await _origApiFetch("/auth/web/login/totp", {
            method: "POST",
            body: JSON.stringify({ challenge_token: challengeToken, code }),
          });
          if (status === 200 && body && body.ok) {
            state.csrfToken = body.csrf_token;
            state.user = body.user;
            // Close any open sign-in dialog.
            try { document.getElementById("signin-dialog")?.close(); } catch {}
            await onSignedIn();
            resolve(true);
            return true;
          }
          return false;
        },
      });
    });
  }

  // Handle 403 totp_required by prompting the user + retrying.
  // Used by /api/v1/account/email/change, /totp/disable,
  // /totp/backup-codes/regenerate.
  async function stepUpTotpAndRetry(originalReq) {
    return new Promise((resolve) => {
      showTotpModal({
        title: "Two-factor required",
        description: "Enter your 6-digit auth-app code (or a backup code) to continue.",
        onSubmit: async (code) => {
          const verify = await apiFetch("/api/v1/account/totp/verify", {
            method: "POST",
            body: JSON.stringify({ code }),
          });
          if (verify.status === 200) {
            const retried = await originalReq();
            resolve(retried);
            return true;
          }
          return false;
        },
      });
    });
  }

  // Wrap apiFetch so callers don't need to know about the
  // step-up dance. Replace the original apiFetch behavior.
  const _origApiFetch = apiFetch;
  apiFetch = async function (path, opts) {
    const result = await _origApiFetch(path, opts);
    if (result.status === 403 && result.body && result.body.error === "totp_required") {
      return stepUpTotpAndRetry(() => _origApiFetch(path, opts));
    }
    return result;
  };

  // ── Click delegation for new pages ─────────────────────────────

  document.body.addEventListener("click", (e) => {
    if (e.target.closest("#register-submit")) {
      e.preventDefault();
      doRegisterSubmit();
    }
    if (e.target.closest("#forgot-submit")) {
      e.preventDefault();
      doForgotSubmit();
    }
    if (e.target.closest("#reset-submit")) {
      e.preventDefault();
      doResetSubmit();
    }
    if (e.target.closest("#totp-confirm")) {
      e.preventDefault();
      doConfirmTotp();
    }
    if (e.target.closest("#backup-confirm")) {
      e.preventDefault();
      navigate("/welcome");
    }
    if (e.target.closest("#welcome-pay")) navigate("/subscription");
    if (e.target.closest("#welcome-redeem")) navigate("/redeem");
    if (e.target.closest("#welcome-squad")) navigate("/move-squad");
    if (e.target.closest("[data-squad-pack]")) {
      const size = parseInt(e.target.closest("[data-squad-pack]").getAttribute("data-squad-pack"), 10);
      doMoveSquadCheckout(size);
    }
  });

  // Helper: HTML-escape (not exposed by the existing helpers).
  function escape(v) {
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  loadCurrentUser();
})();
