// Netlify adapter. All logic lives in src/api/handlers.js; this file only translates
// between the Fetch API request/response and the shared router.
import { routeApi } from "../../src/api/handlers.js";

async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // A malformed body is the caller's mistake (400), not a server failure (500).
    const err = new Error("Request body is not valid JSON");
    err.status = 400;
    throw err;
  }
}

function pathSegments(req) {
  const pathname = new URL(req.url).pathname.replace(/^\/(?:api|\.netlify\/functions\/api)\/?/, "");
  return pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method);
    const result = await routeApi({
      method: req.method,
      segments: pathSegments(req),
      body: hasBody ? await readJson(req) : undefined,
      authorization: req.headers.get("authorization"),
      query: Object.fromEntries(new URL(req.url).searchParams),
      ip: context?.ip || req.headers.get("x-nf-client-connection-ip") || null
    });

    if (result.status === 204 || result.body === null) return new Response(null, { status: result.status });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return Response.json({ error: err.message || "Internal server error" }, { status });
  }
};

export const config = {
  path: "/api/*"
};
