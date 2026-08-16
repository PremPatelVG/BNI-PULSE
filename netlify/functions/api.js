// Netlify adapter. All logic lives in src/api/handlers.js; this file only translates
// between the Fetch API request/response and the shared router.
import { routeApi } from "../../src/api/handlers.js";

async function readJson(req) {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

function pathSegments(req) {
  const pathname = new URL(req.url).pathname.replace(/^\/(?:api|\.netlify\/functions\/api)\/?/, "");
  return pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method);
    const result = await routeApi({
      method: req.method,
      segments: pathSegments(req),
      body: hasBody ? await readJson(req) : undefined,
      authorization: req.headers.get("authorization")
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
