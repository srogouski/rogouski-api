# Rogouski API — Setup & How It Works

A plain-language walkthrough of how this project was built, how each piece fits
together, and what state it's currently in. For the command reference, see the
root `README.md`; this doc is the "why" and "how."

---

## 1. What this is

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) (serverless
function) written in TypeScript that powers an email subscription list. It:

- accepts email signups,
- stores them in a [Cloudflare D1](https://developers.cloudflare.com/d1/)
  database (SQLite at the edge),
- confirms a subscriber via a one-time token (double opt-in),
- serves API documentation (Swagger) behind an API key.

**Live URL:** `https://rogouski-api.rogouski.workers.dev`

---

## 2. The moving parts

| Piece | What it is | Where it lives |
| --- | --- | --- |
| Worker | The code that runs on every request | `src/index.ts` |
| OpenAPI spec | Machine-readable description of the API | `src/openapi.ts` |
| D1 database | Where subscribers are stored | Cloudflare (`rogouski-subscribers`) |
| Migration | SQL that creates the `subscribers` table | `migrations/0001_create_subscribers.sql` |
| Wrangler config | Ties the Worker to the D1 database | `wrangler.toml` |
| Email provider | Sends confirmation emails | Resend (domain `stephenrogouski.com`) |
| API key | Secret guarding the `/docs` route | Cloudflare secret `API_KEY` |

A **Worker** is a single script Cloudflare runs for every incoming request.
There's no server to manage. The routing (which URL does what) lives inside the
code, not in any Cloudflare dashboard setting.

**D1** is a SQLite database Cloudflare hosts and exposes to the Worker through a
*binding* named `DB`. The Worker talks to it with `env.DB.prepare(...)`.

---

## 3. How it was set up (the order things happened)

1. **Scaffolded the project** — `package.json`, `tsconfig.json`, dependencies
   (`zod` for validation; `wrangler`, `typescript`, `@cloudflare/workers-types`
   for tooling).
2. **Wrote `wrangler.toml`** — declared the Worker name, entry point, and the D1
   binding (`DB`). The `database_id` was a placeholder until the DB existed.
3. **Wrote the migration** — `migrations/0001_create_subscribers.sql` defines the
   `subscribers` table.
4. **Wrote the Worker** — `src/index.ts` (routing + handlers) and `src/openapi.ts`
   (the API description shown in Swagger).
5. **Installed deps and type-checked** — `npm install`, then `tsc --noEmit` to
   confirm the TypeScript is sound.
6. **Verified locally** — applied the migration to a *local* simulated D1 and ran
   `wrangler dev` to smoke-test every endpoint before touching production.
7. **Authenticated Wrangler** — `wrangler login` (one-time browser OAuth to the
   Cloudflare account).
8. **Created the real database** — `wrangler d1 create rogouski-subscribers`,
   then pasted the returned `database_id` into `wrangler.toml`.
9. **Applied the migration remotely** — `wrangler d1 migrations apply ... --remote`.
10. **Set the API key secret** — `wrangler secret put API_KEY` (the value is typed
    at the prompt; it is never stored in the repo).
11. **Deployed** — `wrangler deploy`, which also registered the free
    `*.workers.dev` subdomain.

> A setup gotcha we hit: `wrangler secret put <NAME>` takes the secret *name* as
> the argument and the *value* at the prompt afterward. Putting the value in the
> argument slot creates a wrongly-named secret. The secret must be named exactly
> `API_KEY` because the code reads `env.API_KEY`.

---

## 4. How each endpoint works

### `POST /subscribe` (public)

1. Parses the JSON body.
2. Validates `email` with Zod — it also trims whitespace and lowercases the
   address so `Foo@Bar.com` and `foo@bar.com` are the same subscriber.
3. Generates a random `confirm_token` (a UUID).
4. Inserts a row with `confirmed = 0` (pending).
5. Emails a confirmation link (`/confirm?token=...`) to the subscriber via Resend.
6. Returns `201` with a message — **the token is not in the response**; it is
   delivered only by email.

Edge cases:
- Malformed JSON → `400`.
- Invalid email → `400` with the validation detail.
- Email already exists (the `email` column is `UNIQUE`) → `200` with an
  "already subscribed" message, not an error.
- The row was stored but the email failed to send → `502` (the subscriber is
  pending; they can retry).

### `GET /confirm?token=<uuid>` (public)

1. Validates the token is a UUID.
2. Looks up the subscriber by `confirm_token`.
3. Sets `confirmed = 1` and returns a styled HTML success page.

Edge cases: missing/invalid token → `400`; unknown token → `404`; already
confirmed → friendly "already confirmed" page.

### `GET /docs` (protected)

Checks the `Authorization` header against the `API_KEY` secret. Missing or wrong
key → `403`. Correct key → the Swagger UI page. Accepts either a raw key or a
`Bearer <key>` form.

### `GET /health` (public)

- `/health` → `{"status":"ok"}`. No database touched — intended for uptime
  monitors, effectively free.
- `/health?deep=1` → also runs `SELECT 1` against D1 and reports `db: "ok"`, or
  `503` if the database is unreachable.

---

## 5. Data model

Table `subscribers` (see the migration for the exact DDL):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER | Primary key, autoincrement |
| `email` | TEXT | Unique, not null |
| `created_at` | TEXT | Defaults to `datetime('now')` |
| `confirmed` | INTEGER | `0` pending, `1` confirmed |
| `confirm_token` | TEXT | Unique UUID used by `/confirm` |

Note: `id` autoincrement never reuses numbers. After rows are deleted, the next
insert continues from the previous high-water mark (this is normal SQLite
behavior).

---

## 6. Viewing the API methods

Three ways to see the endpoint catalog:

1. **Local docs (recommended for convenience):** `npm run docs` regenerates
   `docs.html` from `src/openapi.ts`; open it in a browser. Nothing is deployed or
   exposed. Requires internet at view time (Swagger UI loads from a CDN).
2. **Live `/docs`:** the deployed Swagger UI, but it needs the API key in the
   `Authorization` header, so a plain browser visit returns `403`.
3. **The source:** the routing block at the top of `src/index.ts`.

> **"Try it out" in Swagger makes real calls.** It is not a simulation. Executing
> `POST /subscribe` writes a real row to the production database.

---

## 7. Confirmation email (Resend)

Double opt-in is implemented. On subscribe, the Worker sends a confirmation
email containing a `/confirm?token=...` link. **The token is delivered only by
email — it is no longer returned in the API response.** This removes the earlier
security weakness (the token used to come back to any caller).

### Why the Worker can't send email directly

Delivering to an inbox requires speaking to mail servers and, crucially, being
*trusted* by providers like Gmail so the message isn't dropped as spam. Workers
don't have that. So email is delegated to a specialized provider (think "Stripe,
but for email") called over HTTPS with an API key. We use **Resend**.

### How it's wired up

- **`sendConfirmationEmail()`** in `src/index.ts` POSTs to the Resend API
  (`https://api.resend.com/emails`) with an `Authorization: Bearer` header, the
  `from` sender, the recipient, and an HTML + plain-text body containing the
  confirmation link.
- `handleSubscribe` calls it after the DB insert. On success → `201` (no token).
  If the email fails to send → `502` (the subscriber row stays pending so they
  can retry).

### Configuration

| Name | Where | Value |
| --- | --- | --- |
| `RESEND_API_KEY` | Worker **secret** | `wrangler secret put RESEND_API_KEY` (a `re_...` key) |
| `EMAIL_FROM` | `wrangler.toml` `[vars]` | `Rogouski <noreply@stephenrogouski.com>` |
| `PUBLIC_BASE_URL` | `wrangler.toml` `[vars]` | `https://rogouski-api.rogouski.workers.dev` |

The `EMAIL_FROM` address must be on a **Resend-verified domain**.

### Domain setup that was done (Resend + AWS Route 53)

The sending domain `stephenrogouski.com` was verified in Resend by adding DNS
records in **AWS Route 53** (the domain's DNS host):

| Purpose | Name | Type | Notes |
| --- | --- | --- | --- |
| DKIM | `resend._domainkey` | TXT | long `p=MIG...` key, value wrapped in quotes |
| SPF | `rsend` | CNAME | `rsend.forge.rmta.net` (bare, no quotes) |
| SPF | `send` | CNAME | `send.forge.rmta.net` (bare, no quotes) |
| DMARC | `_dmarc` | TXT | `"v=DMARC1; p=none;"` (optional, recommended) |

Route 53 gotchas worth remembering: it auto-appends the zone name, so you enter
only the short name (e.g. `resend._domainkey`, not the full FQDN); TXT values must
be in double quotes; CNAME values must **not** be quoted.

---

## 8. Rate limiting

`/subscribe` is protected by the Cloudflare Workers Rate Limiting binding
(`SUBSCRIBE_LIMITER` in `wrangler.toml`): 5 requests per 60 seconds, keyed on the
caller's IP (IPv6 reduced to its /64 prefix for a stable key). Over the limit
returns `429`.

Important caveats about how this behaves:
- Limits are **approximate and enforced per Cloudflare location**, and counts
  update in the background. Requests can briefly exceed the limit, and low-volume
  manual testing from a single machine may not trip it. It protects against real
  abuse volume from a source, which is the actual threat.
- It is **not** a strict global cap. For hard guarantees, Cloudflare's "strict
  limits" (Durable Object backed) would be required — overkill here.
- Requires Wrangler v4+ (the `ratelimits` config key). Older Wrangler silently
  ignores it, leaving the binding `undefined`.

The real defense against IP-rotating abuse is a human check such as Cloudflare
Turnstile; add it only if abuse actually appears, to avoid adding signup friction
preemptively.

## 9. Known next steps (not yet built)

- **Automated tests** — the project has been verified by hand, not by a test
  suite.
- **A protected `/subscribers` endpoint** — if you want to pull the list
  programmatically instead of querying D1 directly.
- **Cloudflare Turnstile** on `/subscribe` — if real abuse appears.
