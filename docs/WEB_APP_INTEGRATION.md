# Web App Integration — Subscribe Feature

How to add an email signup form to a web app that talks to the Rogouski
subscription API. This covers the browser (client-side) flow, which is the usual
case for a signup form.

**API base URL:** `https://rogouski-api.rogouski.workers.dev`

---

## 1. The endpoint

`POST /subscribe`

- **Headers:** `Content-Type: application/json`
- **Body:** `{ "email": "user@example.com" }`
- **Auth:** none (public)

What happens: the email is validated and stored as *pending*, and a confirmation
email with a `/confirm?token=...` link is sent to the address. The subscriber
isn't active until they click that link (double opt-in). The confirmation token
is **never** returned in the response — only emailed.

### Responses

| Status | Meaning | Suggested UI message |
| --- | --- | --- |
| `201` | Subscribed; confirmation email sent | "Check your email to confirm your subscription." |
| `200` | Email already subscribed | "You're already on the list." |
| `400` | Invalid email or malformed JSON | "Please enter a valid email address." |
| `502` | Stored, but the email failed to send | "Something went wrong sending your email. Please try again." |

All responses are JSON with a `message` (or `error`) field. Treat **both `200`
and `201` as success** from the user's point of view.

---

## 2. CORS — which sites can call this

Browser calls are restricted to an allowlist of origins. A request from any other
origin is blocked by the browser (the API returns no `Access-Control-Allow-Origin`
header for it). Currently allowed:

- `https://stephenrogouski.com` and `https://www.stephenrogouski.com`
- `https://stephenross.com` and `https://www.stephenross.com`
- `http://localhost:3000`, `http://localhost:5173`, `http://localhost:8788` (dev)

If you serve your app from a different origin, it must be added to the
`ALLOWED_ORIGINS` list in the Worker (`src/index.ts`) and redeployed. The browser
automatically sends a `OPTIONS` preflight before the `POST`; the Worker answers it.

> **Exact-match origins.** `https://stephenrogouski.com` and
> `https://www.stephenrogouski.com` are different origins — both are allowed, but
> whichever one your page is served from must be in the list.

---

## 3. Plain HTML + JavaScript

A minimal, accessible signup form:

```html
<form id="subscribe-form">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email" />
  <button type="submit">Subscribe</button>
  <p id="subscribe-status" role="status" aria-live="polite"></p>
</form>

<script>
  const API = "https://rogouski-api.rogouski.workers.dev";
  const form = document.getElementById("subscribe-form");
  const status = document.getElementById("subscribe-status");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const button = form.querySelector("button");

    button.disabled = true;
    status.textContent = "Submitting…";

    try {
      const res = await fetch(`${API}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 201) {
        status.textContent = "Check your email to confirm your subscription.";
        form.reset();
      } else if (res.status === 200) {
        status.textContent = "You're already on the list.";
      } else if (res.status === 400) {
        status.textContent = "Please enter a valid email address.";
      } else {
        status.textContent =
          data.message || "Something went wrong. Please try again.";
      }
    } catch (err) {
      // Network/CORS failure (e.g. this origin isn't allowlisted).
      status.textContent = "Couldn't reach the server. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
</script>
```

---

## 4. React (hook-based)

```jsx
import { useState } from "react";

const API = "https://rogouski-api.rogouski.workers.dev";

export function SubscribeForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState({ state: "idle", message: "" });

  async function onSubmit(e) {
    e.preventDefault();
    setStatus({ state: "loading", message: "Submitting…" });

    try {
      const res = await fetch(`${API}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 201) {
        setStatus({ state: "ok", message: "Check your email to confirm." });
        setEmail("");
      } else if (res.status === 200) {
        setStatus({ state: "ok", message: "You're already on the list." });
      } else if (res.status === 400) {
        setStatus({ state: "error", message: "Please enter a valid email." });
      } else {
        setStatus({
          state: "error",
          message: data.message || "Something went wrong. Please try again.",
        });
      }
    } catch {
      setStatus({ state: "error", message: "Couldn't reach the server." });
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />
      <button type="submit" disabled={status.state === "loading"}>
        Subscribe
      </button>
      <p role="status" aria-live="polite">{status.message}</p>
    </form>
  );
}
```

---

## 5. What NOT to do

- **Don't send an API key.** `/subscribe` is public; it needs no `Authorization`
  header. (The `API_KEY` is only for `/docs`.)
- **Don't expect a token back.** The confirmation token is emailed, never in the
  response. Your UI's job ends at "check your email."
- **Don't use `credentials: "include"`.** The API doesn't use cookies, and that
  mode would conflict with the CORS setup.
- **Don't rely only on client-side validation.** The API validates with Zod, so
  invalid emails return `400` regardless — handle it, but the browser `type="email"`
  check is a UX nicety, not the source of truth.

---

## 6. Testing checklist

1. From an allowlisted origin, submit a valid email → `201`, "check your email."
2. Submit the same email again → `200`, "already on the list."
3. Submit an invalid email (`abc`) → `400`.
4. Open your browser devtools Network tab and confirm the `OPTIONS` preflight
   returns `204` with `Access-Control-Allow-Origin` set to your origin.
5. Check the inbox, click the confirm link → the success page loads and the
   subscriber becomes confirmed.

If step 4 fails (no `Access-Control-Allow-Origin`), your origin isn't in the
Worker's allowlist — add it to `ALLOWED_ORIGINS` in `src/index.ts` and redeploy.

---

## 7. Server-side (non-browser) calls

CORS is a browser mechanism; it does not apply to server-to-server requests. If
your backend calls `/subscribe` (e.g. from a Node service), just POST the JSON —
no `Origin` header or allowlist is involved.

```js
await fetch("https://rogouski-api.rogouski.workers.dev/subscribe", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "user@example.com" }),
});
```
