// Generates a self-contained docs.html from the same OpenAPI spec the Worker serves.
// Local convenience only: no network calls to your API, no deploy, no API key.
// Run: npm run docs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Node can't import a .ts file without a loader, so we extract the exported
// object literal from the source text. The spec is a plain literal (no runtime
// values), which makes this safe and stable.
const src = readFileSync(join(root, "src", "openapi.ts"), "utf8");
const start = src.indexOf("{", src.indexOf("openApiSpec"));
const end = src.lastIndexOf("} as const");
if (start === -1 || end === -1) {
  throw new Error("Could not locate the openApiSpec object in src/openapi.ts");
}
const spec = (0, eval)("(" + src.slice(start, end + 1) + ")");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rogouski API Docs (local)</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style> body { margin: 0; } </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      spec: ${JSON.stringify(spec)},
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis]
    });
  </script>
</body>
</html>`;

const out = join(root, "docs.html");
writeFileSync(out, html, "utf8");
console.log("Wrote " + out + " — open it in a browser.");
