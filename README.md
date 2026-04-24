# Hexis Accounts (`accounts.hexis.chat`)

Static site for managing Hexis account state — subscriptions,
billing, API keys, and bot OAuth applications. Hosted on
Cloudflare Pages; the project name in CF is `hexis-accounts`.

Currently a scaffold — the four cards on the landing page mark
where the real flows will live.

## Layout

```
.
├── index.html      ← landing page + 4 placeholder cards
├── 404.html        ← Cloudflare Pages serves this on miss
├── styles.css      ← dark theme, matches the Hexis admin console palette
├── _headers        ← Pages security headers (CSP, HSTS, frame-deny, etc.)
├── wrangler.toml   ← Pages project metadata
└── README.md
```

No build step. Browsers serve `index.html` + `styles.css`
directly; tweaks land on the next `wrangler pages deploy`.

## Local preview

```sh
# Anything that serves the cwd works
python3 -m http.server 8000
# → http://localhost:8000
```

## Deploy

The Pages project is provisioned once; subsequent deploys
overwrite the production environment.

```sh
# First time only — provision the project
wrangler pages project create hexis-accounts --production-branch main

# Every deploy
wrangler pages deploy . --project-name hexis-accounts
```

The `accounts.hexis.chat` custom domain is attached via the
Cloudflare dashboard (Pages → hexis-accounts → Custom domains).

## Roadmap (rough sketch)

The cards on the landing page each open into a real flow once
the backend pieces land.

| Card | Notes |
|------|-------|
| Subscription | Plan picker; first-party clients free, paid tiers unlock larger media + retention. |
| Billing | Stripe Checkout / Customer Portal handoff. |
| API keys | Personal automation keys, scope-gated. Create / list / revoke. |
| Bots | OAuth 2.1 + PKCE app registration, redirect URI mgmt, scope picker. |

The Hexis backend exposes whatever HTTP endpoints these flows
need — this site is purely the operator UI sitting on top of
them.
