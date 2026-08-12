import { config as appConfig } from "../../src/config.js";

export default async () => {
  return Response.json({
    ok: true,
    service: "bni-pulse",
    environment: appConfig.env,
    runtime: "netlify-functions"
  });
};

export const config = {
  path: "/healthz"
};
