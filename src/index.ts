import { z } from "zod";
import { openApiSpec } from "./openapi";

export interface Env {
  DB: D1Database;
  API_KEY: string;
  // Email (Resend). RESEND_API_KEY is a secret; the others come from wrangler.toml vars.
  RESEND_API_KEY: string;
  EMAIL_FROM: string; // e.g. "Rogouski <noreply@stephenrogouski.com>"
  PUBLIC_BASE_URL: string; // e.g. "https://rogouski-api.rogouski.workers.dev"
}

const subscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }

    if (pathname === "/confirm" && request.method === "GET") {
      return handleConfirm(url, env);
    }

    if (pathname === "/docs" && request.method === "GET") {
      return handleDocs(request, env);
    }

    if (pathname === "/health" && request.method === "GET") {
      return handleHealth(url, env);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = subscribeSchema.safeParse(payload);
  if (!parsed.success) {
    return json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const { email } = parsed.data;
  const token = crypto.randomUUID();

  try {
    const result = await env.DB.prepare(
      "INSERT INTO subscribers (email, confirm_token) VALUES (?, ?)",
    )
      .bind(email, token)
      .run();

    if (!result.success) {
      return json({ error: "Failed to store subscriber" }, 500);
    }
  } catch (err) {
    // UNIQUE constraint on email => already subscribed.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return json({ message: "Email already subscribed" }, 200);
    }
    return json({ error: "Database error" }, 500);
  }

  // Send the confirmation email. If sending fails, the subscriber row still
  // exists (pending); we surface a 502 so the caller knows delivery didn't happen.
  const sent = await sendConfirmationEmail(env, email, token);
  if (!sent) {
    return json(
      {
        message:
          "Subscribed, but the confirmation email could not be sent. Please try again later.",
      },
      502,
    );
  }

  // Note: the token is intentionally NOT returned. It is delivered only via email.
  return json({ message: "Subscribed. Check your email to confirm." }, 201);
}

async function sendConfirmationEmail(
  env: Env,
  email: string,
  token: string,
): Promise<boolean> {
  const confirmUrl = `${env.PUBLIC_BASE_URL}/confirm?token=${encodeURIComponent(token)}`;

  const html = `<!doctype html>
<html lang="en">
<body style="font-family: system-ui, sans-serif; color: #0f172a; line-height: 1.6;">
  <h2>Confirm your subscription</h2>
  <p>Thanks for subscribing. Click the button below to confirm your email address.</p>
  <p>
    <a href="${confirmUrl}"
       style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;
              border-radius:8px;text-decoration:none;">Confirm subscription</a>
  </p>
  <p>Or paste this link into your browser:<br />
    <a href="${confirmUrl}">${confirmUrl}</a>
  </p>
  <p style="color:#64748b;font-size:13px;">
    If you didn't request this, you can safely ignore this email.
  </p>
</body>
</html>`;

  const text = `Confirm your subscription by opening this link:\n${confirmUrl}\n\nIf you didn't request this, ignore this email.`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: email,
        subject: "Confirm your subscription",
        html,
        text,
      }),
    });

    if (!res.ok) {
      console.error("Resend send failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Resend send threw", err instanceof Error ? err.message : err);
    return false;
  }
}

async function handleConfirm(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");

  const tokenSchema = z.string().uuid();
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    return html(confirmPage("Invalid or missing confirmation token.", false), 400);
  }

  const row = await env.DB.prepare(
    "SELECT id, confirmed FROM subscribers WHERE confirm_token = ?",
  )
    .bind(parsed.data)
    .first<{ id: number; confirmed: number }>();

  if (!row) {
    return html(confirmPage("This confirmation link is not valid.", false), 404);
  }

  if (row.confirmed === 1) {
    return html(confirmPage("Your subscription was already confirmed.", true), 200);
  }

  await env.DB.prepare("UPDATE subscribers SET confirmed = 1 WHERE id = ?")
    .bind(row.id)
    .run();

  return html(confirmPage("Your subscription is confirmed. Thank you!", true), 200);
}

async function handleHealth(url: URL, env: Env): Promise<Response> {
  // Liveness by default (free): the Worker responded, so it's up.
  // Readiness on demand (?deep=1): also probe D1 with the cheapest query.
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    return json({ status: "ok" });
  }

  try {
    await env.DB.prepare("SELECT 1").first();
    return json({ status: "ok", db: "ok" });
  } catch {
    return json({ status: "degraded", db: "error" }, 503);
  }
}

function handleDocs(request: Request, env: Env): Response {
  const authError = checkApiKey(request, env);
  if (authError) return authError;
  return html(swaggerUiPage());
}

function checkApiKey(request: Request, env: Env): Response | null {
  const provided = request.headers.get("authorization");
  // Accept either a raw key or a "Bearer <key>" form.
  const key = provided?.startsWith("Bearer ")
    ? provided.slice("Bearer ".length).trim()
    : provided?.trim();

  if (!key || !env.API_KEY || key !== env.API_KEY) {
    return json({ error: "Forbidden" }, 403);
  }
  return null;
}

function confirmPage(message: string, success: boolean): string {
  const color = success ? "#16a34a" : "#dc2626";
  const heading = success ? "Confirmed" : "Something went wrong";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${heading}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f8fafc; margin: 0;
           display: grid; place-items: center; min-height: 100vh; }
    .card { background: #fff; padding: 2.5rem 3rem; border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
    h1 { color: ${color}; margin: 0 0 .5rem; font-size: 1.5rem; }
    p { color: #475569; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

function swaggerUiPage(): string {
  // Swagger UI from CDN. The spec is inlined directly into the page so the browser
  // does not need to make a second (API-key protected) request to fetch it.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rogouski API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style> body { margin: 0; } </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      spec: ${JSON.stringify(openApiSpec)},
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis]
    });
  </script>
</body>
</html>`;
}
