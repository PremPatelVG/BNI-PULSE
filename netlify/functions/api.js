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

// API answers carry member data: never cached on the way, never sniffed as another type.
const API_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: API_HEADERS });

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

    if (result.status === 204 || result.body === null) return new Response(null, { status: result.status, headers: API_HEADERS });
    return Response.json(result.body, { status: result.status, headers: API_HEADERS });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return Response.json({ error: err.message || "Internal server error" }, { status, headers: API_HEADERS });
  }
};

export const config = {
  path: "/api/*"
};
