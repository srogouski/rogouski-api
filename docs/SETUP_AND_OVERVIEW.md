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
5. Returns `201` with the token.

Edge cases:
- Malformed JSON → `400`.
- Invalid email → `400` with the validation detail.
- Email already exists (the `email` column is `UNIQUE`) → `200` with an
  "already subscribed" message, not an error.

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

## 7. Current state and the email gap

Everything above is built, deployed, and working. **One thing is intentionally
not yet built: sending email.**

Today, `/subscribe` returns the `confirm_token` in the HTTP response body. There
is **no email sent** — the "Check your email to confirm" message is a placeholder.
To confirm a subscriber right now, you take the token from the response (or look
it up in the database) and open `/confirm?token=...` yourself.

This is fine for testing but **not acceptable for a real mailing list**, because:

- a real subscriber never sees the HTTP response, so they can't get the token;
- returning the token to the caller is a security weakness (anyone who can call
  subscribe receives the confirmation token directly).

### Why the Worker can't just send email itself

Delivering to an inbox requires speaking to mail servers and, crucially, being
*trusted* by providers like Gmail so the message isn't dropped as spam. Workers
don't have that. So email is delegated to a specialized provider (think "Stripe,
but for email") that you call over HTTPS with an API key.

### The plan to close the gap

A provider such as **Resend** has a free tier (3,000 emails/month). The flow to
finish double opt-in:

1. Create a provider account; get an API key.
2. Verify a **domain you own** (a DNS step, not a payment) so mail can be sent
   *from* your address. This is the one real requirement — a domain costs roughly
   $10–12/year and is unavoidable for a legitimate mailing list. Without it, free
   tiers only let you send to your own verified address (testing only).
3. Store the provider API key as another Worker secret (like `API_KEY`).
4. Update `handleSubscribe` to email the confirmation link instead of returning
   the token, and change the response message to be truthful.

Until that's done, the token-in-response flow keeps working for testing.

---

## 8. Known next steps (not yet built)

- **Email sending** for real double opt-in (see section 7) — required before a
  real mailing list.
- **Rate limiting on `/subscribe`** — it's a public write endpoint with no
  throttle today; abusable without a limit.
- **Automated tests** — the project has been verified by hand, not by a test
  suite.
- **A protected `/subscribers` endpoint** — if you want to pull the list
  programmatically instead of querying D1 directly.
