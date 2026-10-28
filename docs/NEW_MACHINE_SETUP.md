# Setup on a New Machine

What you need to do after cloning this repo on a fresh machine. A clone gives you
all source, config, docs, and scripts — but a few things are intentionally **not**
in git and must be set up locally.

## What is NOT in the repo (and why)

| Item | Why it's missing | What you do |
| --- | --- | --- |
| `node_modules/` | dependencies aren't committed | `npm install` |
| Cloudflare login | the auth session is per-machine | `npx wrangler login` |
| `API_KEY`, `RESEND_API_KEY` | secrets live in Cloudflare, not git | nothing for deploy; recreate `.dev.vars` for local dev |
| `.dev.vars` | git-ignored (holds secrets) | recreate only if you run `wrangler dev` |
| `.wrangler/` | local D1 state | re-run the local migration if testing locally |
| `docs.html`, `*.csv` | generated / contain data | regenerate as needed |

What you do **not** need to redo: the remote D1 database and its migration already
exist in the Cloudflare account, and `wrangler.toml` already contains the
`database_id`. A fresh clone is already pointed at the right database.

---

## Minimum to deploy

```bash
git clone https://github.com/srogouski/rogouski-api.git
cd rogouski-api
npm install
npx wrangler login      # opens a browser; authenticates this machine
npm run deploy
```

That's it. The secrets (`API_KEY`, `RESEND_API_KEY`) are already set on the
deployed Worker in Cloudflare, so you don't re-enter them just to deploy.

> You must log in to the **same Cloudflare account** that owns the Worker and the
> D1 database. `npx wrangler whoami` shows who you're logged in as.

---

## Full local development setup

If you want to run and test locally with `wrangler dev`:

1. **Install + log in** (as above): `npm install`, `npx wrangler login`.

2. **Create `.dev.vars`** in the project root (git-ignored). Local dev reads
   secrets from here instead of Cloudflare:

   ```
   API_KEY=some-local-key
   RESEND_API_KEY=re_your_key   # only needed if you want local runs to send email
   ```

3. **Apply the migration to the local database** (a separate, simulated DB):

   ```bash
   npm run db:migrate:local
   ```

4. **Run it:**

   ```bash
   npm run dev
   ```

Local dev uses a local simulated D1 that starts empty — it does not touch
production data. Seed it with `./scripts/add-subscriber.ps1 -Local` if needed.

---

## If you ever need to recreate everything from scratch

(For example, a brand-new Cloudflare account — not your current situation, since
the database already exists.)

1. `npm run db:create` → paste the new `database_id` into `wrangler.toml`.
2. `npm run db:migrate:remote`.
3. `npx wrangler secret put API_KEY` and `npx wrangler secret put RESEND_API_KEY`.
4. Re-verify the Resend sending domain (DNS records — see
   `docs/SETUP_AND_OVERVIEW.md` section 7).
5. `npm run deploy`.

---

## Quick verification after setup

```bash
npx wrangler whoami                                   # correct account?
curl https://rogouski-api.rogouski.workers.dev/health # -> {"status":"ok"}
```

See `README.md` for day-to-day commands and `docs/SETUP_AND_OVERVIEW.md` for how
the whole system works.
