# Rogouski Subscription API

A Cloudflare Worker (TypeScript + Wrangler) that collects email subscriptions into a
Cloudflare D1 database, confirms them via a token, and serves protected Swagger docs.

## Endpoints

| Method | Path        | Auth                       | Description                                            |
| ------ | ----------- | -------------------------- | ------------------------------------------------------ |
| POST   | `/subscribe`| none (public)              | Accepts `{ "email": "..." }`, validates, stores it.    |
| GET    | `/confirm`  | none (public)              | `?token=<uuid>` marks the subscriber confirmed.        |
| GET    | `/docs`     | `Authorization` API key    | Swagger UI. Returns `403` if the key is missing/wrong. |

Request validation uses [Zod](https://zod.dev/).

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

## Run locally

```bash
npm run dev
```

- `curl -X POST http://localhost:8787/subscribe -H "content-type: application/json" -d '{"email":"me@example.com"}'`
- Open the `confirm_token` from the response: `http://localhost:8787/confirm?token=<token>`
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
