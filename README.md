# Rogouski Subscription API

A Cloudflare Worker (TypeScript + Wrangler) that collects email subscriptions into a
Cloudflare D1 database, confirms them with a double opt-in email (via
[Resend](https://resend.com/)), and serves protected Swagger docs.

## Endpoints

| Method | Path        | Auth                       | Description                                                        |
| ------ | ----------- | -------------------------- | ----------------------------------------------------------------- |
| POST   | `/subscribe`| none (public)              | Accepts `{ "email": "..." }`, validates, stores it, emails a link. |
| GET    | `/confirm`  | none (public)              | `?token=<uuid>` marks the subscriber confirmed.                   |
| GET    | `/docs`     | `Authorization` API key    | Swagger UI. Returns `403` if the key is missing/wrong.            |
| GET    | `/subscribers.csv` | `Authorization` API key | Downloads all subscribers as CSV (opens in Excel). `403` without the key. |
| GET    | `/health`   | none (public)              | `{"status":"ok"}`. Add `?deep=1` to also probe the database.      |

Request validation uses [Zod](https://zod.dev/).

On subscribe, the Worker emails a confirmation link to the address. **The
confirmation token is delivered only by email — it is not returned in the API
response.**

## Prerequisites

- Node.js 18+ and npm
- A Cloudflare account
- Wrangler (installed as a dev dependency; run via `npx wrangler ...` or the npm scripts)

```bash
npm install
npx wrangler login
```

## Create the D1 database

1. Create the database:

   ```bash
   npm run db:create
   # equivalent to: npx wrangler d1 create rogouski-subscribers
   ```

2. Wrangler prints a `database_id`. Copy it into `wrangler.toml`, replacing
   `REPLACE_WITH_DATABASE_ID`:

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "rogouski-subscribers"
   database_id = "the-id-wrangler-printed"
   migrations_dir = "migrations"
   ```

## Apply the migration

The schema lives in `migrations/0001_create_subscribers.sql`.

```bash
# Local dev database (for `wrangler dev`):
npm run db:migrate:local

# Remote (production) database:
npm run db:migrate:remote
```

The `subscribers` table:

| Column          | Type    | Notes                                    |
| --------------- | ------- | ---------------------------------------- |
| `id`            | INTEGER | Primary key, autoincrement               |
| `email`         | TEXT    | Unique, not null                         |
| `created_at`    | TEXT    | Defaults to `datetime('now')`            |
| `confirmed`     | INTEGER | `0` pending, `1` confirmed (default `0`) |
| `confirm_token` | TEXT    | Unique UUID used by `/confirm`           |

## Set the API key secret

The `/docs` route checks the `Authorization` header against the `API_KEY` secret.

```bash
npx wrangler secret put API_KEY
# paste your key when prompted
```

For local dev, put it in a `.dev.vars` file (git-ignored):

```
API_KEY=your-local-key
```

## Set up email (Resend)

The confirmation email is sent through [Resend](https://resend.com/).

1. Create a Resend account and **verify your sending domain** (add the DKIM/SPF
   records Resend gives you in your DNS provider). This project uses
   `stephenrogouski.com`, with DNS hosted in AWS Route 53.
2. Create a Resend API key (`re_...`) and set it as a Worker secret:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   # paste the re_... key when prompted
   ```

3. The sender and base URL are non-secret vars in `wrangler.toml`:

   ```toml
   [vars]
   EMAIL_FROM = "Rogouski <noreply@stephenrogouski.com>"
   PUBLIC_BASE_URL = "https://rogouski-api.rogouski.workers.dev"
   ```

   `EMAIL_FROM` must use a Resend-verified domain. `PUBLIC_BASE_URL` is used to
   build the `/confirm?token=...` link in the email.

For local dev that actually sends email, add `RESEND_API_KEY` to `.dev.vars` too.
On a successful subscribe the Worker returns `201`; if the email fails to send it
returns `502` (the subscriber row is still stored as pending).

See `docs/SETUP_AND_OVERVIEW.md` for the full email flow and the exact Route 53
records that were used.

## Run locally

```bash
npm run dev
```

- `curl -X POST http://localhost:8787/subscribe -H "content-type: application/json" -d '{"email":"me@example.com"}'`
- The confirmation link is sent by email (not returned in the response). To get a
  token for local testing without sending mail, read it from the database:
  `npx wrangler d1 execute rogouski-subscribers --local --command "SELECT email, confirm_token FROM subscribers"`
  then open `http://localhost:8787/confirm?token=<token>`.
- Docs: `curl http://localhost:8787/docs -H "Authorization: your-local-key"`

## Deploy

```bash
npm run deploy
```

## Notes

- `/docs` accepts either a raw key (`Authorization: <key>`) or a bearer token
  (`Authorization: Bearer <key>`).
- Subscribing the same email twice returns `200` with an "already subscribed" message
  rather than an error.
- A successful subscribe returns `201` (no token in the body). If the row was stored
  but the confirmation email failed to send, it returns `502`.

## Admin: export subscribers to CSV/Excel

`GET /subscribers.csv` downloads all subscribers as a CSV file that opens directly
in Excel. It exposes every subscriber's email, so it is **protected by the API
key** (same key as `/docs`) and returns `403` without it.

```bash
# All subscribers:
curl -L "https://rogouski-api.rogouski.workers.dev/subscribers.csv" \
  -H "Authorization: <API_KEY>" -o subscribers.csv

# Only confirmed subscribers (the list you'd actually email):
curl -L "https://rogouski-api.rogouski.workers.dev/subscribers.csv?confirmed=1" \
  -H "Authorization: <API_KEY>" -o subscribers.csv
```

Columns: `id, email, created_at, confirmed`. The file is UTF-8 with a BOM so Excel
renders accented characters correctly. Opening the saved `.csv` in Excel shows it
as a spreadsheet; no conversion needed.

In a browser you can't attach the `Authorization` header to a plain navigation, so
use `curl` (above) or a header-injecting extension like ModHeader.

## Admin: add subscribers directly

`scripts/add-subscriber.ps1` inserts addresses straight into D1, bypassing the
public `/subscribe` flow — **no confirmation email is sent**. Use it only for
addresses you already have consent for. Each row gets a generated `confirm_token`
(the schema requires one), and existing emails are skipped (`INSERT OR IGNORE`).

Run from the project root with Wrangler authenticated.

```powershell
# Single address, inserted as already-confirmed, into production:
./scripts/add-subscriber.ps1 -Email someone@example.com -Confirmed

# Single address as pending (confirmed = 0):
./scripts/add-subscriber.ps1 -Email someone@example.com

# Batch from a file (one email per line):
./scripts/add-subscriber.ps1 -File .\emails.txt -Confirmed

# Target the local dev database instead of production:
./scripts/add-subscriber.ps1 -Email someone@example.com -Local
```

Flags:
- `-Confirmed` — insert as confirmed (`1`); omit for pending (`0`).
- `-Local` — target the local dev DB instead of remote production.
- Emails are lowercased and format-checked before insert.
