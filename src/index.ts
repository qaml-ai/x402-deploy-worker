import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";
import { nanoid } from "nanoid";

// TODO: When deployed workers run out of funding, serve an x402 payment page
// instead of the worker, so any visitor can top up

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_CODE_SIZE = 1_048_576; // 1 MB

function cfApiUrl(env: Env, scriptName: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}`;
}

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a parameter extractor for a Cloudflare Worker deployment service.
Extract the following from the user's message and return JSON:
- "action": either "deploy" (deploy new worker code) or "status" (check if a worker is active). Default "deploy". (required)
- "code": the JavaScript or TypeScript source code for the Worker. (required for deploy)
- "name": custom name for the worker. (optional, auto-generated if omitted)
- "worker_name": name of the worker to check status for. Required if action is "status". (optional)

Return ONLY valid JSON, no explanation.
Examples:
- {"action": "deploy", "code": "export default { fetch() { return new Response('hello') } }"}
- {"action": "deploy", "code": "export default { fetch() { return new Response('hi') } }", "name": "my-worker"}
- {"action": "status", "worker_name": "my-worker"}`;

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.10", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.10", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.10", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Deploy a Cloudflare Worker or check worker status. Send {\"input\": \"your request\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe what you want: deploy worker code or check status of a deployed worker", required: true },
            },
          },
          output: { type: "json" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(stripeApiKeyMiddleware({ serviceName: "deploy-worker" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: ROUTES["POST /"].accepts.map((a: any) => ({ ...a, payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}` })) },
  }))(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const action = ((params.action as string) || "deploy").toLowerCase();

  if (action === "status") {
    const workerName = params.worker_name as string;
    if (!workerName) {
      return c.json({ error: "Could not determine worker_name to check status" }, 400);
    }

    const cfRes = await fetch(cfApiUrl(c.env, workerName), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
      },
    });

    if (cfRes.status === 404) {
      return c.json({ name: workerName, active: false });
    }

    const cfBody = await cfRes.json<{ success: boolean }>();

    return c.json({
      name: workerName,
      active: cfBody.success === true,
    });
  }

  // Default: deploy
  const code = params.code as string | undefined;

  if (!code || code.trim().length === 0) {
    return c.json({ error: "Could not extract worker code from your input" }, 400);
  }

  if (code.length > MAX_CODE_SIZE) {
    return c.json(
      { error: `Code exceeds maximum size of ${MAX_CODE_SIZE} bytes (1 MB)` },
      400
    );
  }

  const scriptName = (params.name as string)?.trim() || nanoid(12);

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
// DELETE /undeploy/:name — remove a worker (free)
// ---------------------------------------------------------------------------
app.delete("/undeploy/:name", async (c) => {
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

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 Deploy Worker", "deploy.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-deploy-worker",
    description: 'Deploy Cloudflare Workers by uploading code. Send POST / with {"input": "deploy this worker: export default { fetch() { return new Response(\'hello\') } }"}',
    price: "$0.10 per request (Base mainnet)",
    endpoints: {
      "POST /": "$0.10",
      "DELETE /undeploy/:name": "free — remove a deployed worker",
    },
  });
});

export default app;
