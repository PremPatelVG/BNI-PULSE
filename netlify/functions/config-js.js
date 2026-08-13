import { config as appConfig } from "../../src/config.js";

export default async () => {
  return new Response(
    `window.__BNI_PULSE_CONFIG__=${JSON.stringify({ firebase: appConfig.publicFirebase })};`,
    {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
};

export const config = {
  path: "/config.js"
};
