// OpenAPI 3.0 spec served at /docs (behind API key).
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Rogouski Subscription API",
    version: "1.0.0",
    description:
      "Public subscription API backed by Cloudflare D1. Collect emails, confirm via token.",
  },
  paths: {
    "/subscribe": {
      post: {
        summary: "Subscribe an email address",
        description:
          "Accepts a JSON body with an email field, validates it, stores a pending (unconfirmed) subscriber, and emails a confirmation link. The confirmation token is sent only via email and is never returned in the response.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: {
                  email: { type: "string", format: "email" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description:
              "Subscriber created (pending confirmation). A confirmation email has been sent.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                  },
                },
              },
            },
          },
          "200": { description: "Email already subscribed" },
          "400": { description: "Invalid request body" },
          "502": { description: "Subscribed, but the confirmation email failed to send" },
        },
      },
    },
    "/confirm": {
      get: {
        summary: "Confirm a subscription",
        description: "Marks a subscriber as confirmed using the token query parameter.",
        parameters: [
          {
            name: "token",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Subscription confirmed (HTML page)" },
          "400": { description: "Missing or invalid token" },
          "404": { description: "Token not found" },
        },
      },
    },
    "/subscribers.csv": {
      get: {
        summary: "Export subscribers as CSV",
        description:
          "Downloads all subscribers as a CSV file (opens in Excel). Protected by the API key in the Authorization header. Pass ?confirmed=1 to export only confirmed subscribers.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "confirmed",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["1"] },
            description: "When set to 1, export only confirmed subscribers.",
          },
        ],
        responses: {
          "200": {
            description: "CSV file (text/csv) as an attachment",
            content: { "text/csv": { schema: { type: "string" } } },
          },
          "403": { description: "Missing or invalid API key" },
        },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        description:
          "Liveness check by default. Pass ?deep=1 to also probe the D1 database (readiness).",
        parameters: [
          {
            name: "deep",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["1"] },
            description: "When set to 1, also checks database connectivity.",
          },
        ],
        responses: {
          "200": { description: "Service is healthy" },
          "503": { description: "Database check failed (only with ?deep=1)" },
        },
      },
    },
    "/docs": {
      get: {
        summary: "API documentation (Swagger UI)",
        description: "Protected by an API key in the Authorization header.",
        security: [{ ApiKeyAuth: [] }],
        responses: {
          "200": { description: "Swagger UI" },
          "403": { description: "Missing or invalid API key" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "Authorization",
      },
    },
  },
} as const;
