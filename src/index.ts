import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import { nanoid } from "nanoid";

// TODO: When deployed workers run out of funding, serve an x402 payment page
// instead of the worker, so any visitor can top up

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// OpenAPI spec — must be before paymentMiddleware
// ---------------------------------------------------------------------------
app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 Deploy Worker Service",
      description: "Deploy Cloudflare Workers by uploading code. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://deploy.camelai.io" }],
  },
}));

// ---------------------------------------------------------------------------
// x402 payment gates
// ---------------------------------------------------------------------------
app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /deploy": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.10",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Deploy a Cloudflare Worker by uploading code",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                code: {
                  type: "string",
                  description:
                    "JavaScript or TypeScript source code for the Worker",
                  required: true,
                },
                name: {
                  type: "string",
                  description:
                    "Custom name for the worker (auto-generated if omitted)",
                  required: false,
                },
              },
            },
          },
        },
      },
      "GET /status/:name": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Check if a deployed worker is active",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              pathFields: {
                name: {
                  type: "string",
                  description: "Name of the deployed worker",
                  required: true,
                },
              },
            },
          },
        },
      },
    })
  )
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_CODE_SIZE = 1_048_576; // 1 MB

function cfApiUrl(env: Env, scriptName: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}`;
}

// ---------------------------------------------------------------------------
// POST /deploy — deploy a worker ($0.10)
// ---------------------------------------------------------------------------
app.post("/deploy", describeRoute({
  description: "Deploy a Cloudflare Worker by uploading code. Requires x402 payment ($0.10).",
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", description: "JavaScript or TypeScript source code for the Worker" },
            name: { type: "string", description: "Custom name for the worker (auto-generated if omitted)" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "Worker deployed", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Missing or invalid code" },
    402: { description: "Payment required" },
    502: { description: "Deployment failed" },
  },
}), async (c) => {
  const contentType = c.req.header("content-type") || "";

  let code: string | undefined;
  let name: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    code = formData.get("code")?.toString();
    name = formData.get("name")?.toString();
  } else {
    // Also accept JSON body for convenience
    const body = await c.req.json<{ code?: string; name?: string }>();
    code = body.code;
    name = body.name;
  }

  if (!code || code.trim().length === 0) {
    return c.json({ error: "Missing or empty 'code' field" }, 400);
  }

  if (code.length > MAX_CODE_SIZE) {
    return c.json(
      { error: `Code exceeds maximum size of ${MAX_CODE_SIZE} bytes (1 MB)` },
      400
    );
  }

  const scriptName = name?.trim() || nanoid(12);

  // Build multipart form data for the Cloudflare API upload.
  // The Workers API expects a "worker.js" part with the script content
  // and a "metadata" part with configuration.
  const metadata = JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-03-12",
    compatibility_flags: ["nodejs_compat"],
  });

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([metadata], { type: "application/json" }),
    "metadata.json"
  );
  form.append(
    "worker.js",
    new Blob([code], { type: "application/javascript+module" }),
    "worker.js"
  );

  const cfRes = await fetch(cfApiUrl(c.env, scriptName), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
    },
    body: form,
  });

  const cfBody = await cfRes.json<{
    success: boolean;
    errors?: { message: string }[];
  }>();

  if (!cfRes.ok || !cfBody.success) {
    const message =
      cfBody.errors?.map((e) => e.message).join("; ") ||
      "Unknown Cloudflare API error";
    return c.json({ error: `Deployment failed: ${message}` }, 502);
  }

  return c.json({
    name: scriptName,
    url: `https://${scriptName}.${c.env.DISPATCH_NAMESPACE}.workers.dev`,
    deployed_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /status/:name — check worker status ($0.001)
// ---------------------------------------------------------------------------
app.get("/status/:name", describeRoute({
  description: "Check if a deployed worker is active. Requires x402 payment ($0.001).",
  responses: {
    200: { description: "Worker status", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const scriptName = c.req.param("name");

  const cfRes = await fetch(cfApiUrl(c.env, scriptName), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
    },
  });

  if (cfRes.status === 404) {
    return c.json({ name: scriptName, active: false });
  }

  const cfBody = await cfRes.json<{ success: boolean }>();

  return c.json({
    name: scriptName,
    active: cfBody.success === true,
  });
});

// ---------------------------------------------------------------------------
// DELETE /undeploy/:name — remove a worker (free)
// ---------------------------------------------------------------------------
app.delete("/undeploy/:name", describeRoute({
  description: "Remove a deployed worker (free).",
  responses: {
    200: { description: "Worker deleted", content: { "application/json": { schema: { type: "object" } } } },
    404: { description: "Worker not found" },
    502: { description: "Failed to delete worker" },
  },
}), async (c) => {
  const scriptName = c.req.param("name");

  const cfRes = await fetch(cfApiUrl(c.env, scriptName), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
    },
  });

  if (cfRes.status === 404) {
    return c.json({ error: `Worker '${scriptName}' not found` }, 404);
  }

  const cfBody = await cfRes.json<{ success: boolean }>();

  if (!cfBody.success) {
    return c.json({ error: "Failed to delete worker" }, 502);
  }

  return c.json({ name: scriptName, deleted: true });
});

// ---------------------------------------------------------------------------
// Health / info
// ---------------------------------------------------------------------------
app.get("/", describeRoute({
  description: "Health check and service info.",
  responses: {
    200: { description: "Service info", content: { "application/json": { schema: { type: "object" } } } },
  },
}), (c) => {
  return c.json({
    service: "x402-deploy-worker",
    description:
      "Deploy Cloudflare Workers by uploading code. Pay per deploy via x402.",
    endpoints: {
      "POST /deploy": "$0.10 — upload code, get a live worker URL",
      "GET /status/:name": "$0.001 — check if a worker is active",
      "DELETE /undeploy/:name": "free — remove a deployed worker",
    },
    network: "Base mainnet (eip155:8453)",
  });
});

export default app;
