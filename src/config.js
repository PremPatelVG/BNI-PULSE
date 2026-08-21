import dotenv from "dotenv";

dotenv.config();

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || process.env[name] || "";
}

const publicFirebase = {
  apiKey: env("PUBLIC_FIREBASE_API_KEY"),
  authDomain: env("PUBLIC_FIREBASE_AUTH_DOMAIN"),
  projectId: env("PUBLIC_FIREBASE_PROJECT_ID") || env("FIREBASE_PROJECT_ID"),
  storageBucket: env("PUBLIC_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: env("PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
  appId: env("PUBLIC_FIREBASE_APP_ID")
};

const appEnv = env("NODE_ENV") || "development";

export const config = {
  env: appEnv,
  port: Number(env("PORT") || 3000),
  jwtSecret: env("APP_JWT_SECRET") || "dev-only-change-me",
  corsOrigin: env("CORS_ORIGIN"),
  firebase: {
    serviceAccountBase64: env("FIREBASE_SERVICE_ACCOUNT_BASE64"),
    serviceAccountPath: env("FIREBASE_SERVICE_ACCOUNT_PATH"),
    projectId: env("FIREBASE_PROJECT_ID") || publicFirebase.projectId || ""
  },
  publicFirebase,
  srAdminPin: env("SR_ADMIN_PIN"),
  localPreviewPin: appEnv === "production" ? "" : env("LOCAL_PREVIEW_PIN")
};

// Values that must never sign production sessions: they are public, so a token
// signed with any of them can be forged by anyone who has read the repo.
const INSECURE_JWT_SECRETS = new Set([
  "",
  "dev-only-change-me",
  "replace-with-a-long-random-secret"
]);

export function requireProductionSecrets() {
  if (config.env !== "production") return;
  const missing = [];
  if (INSECURE_JWT_SECRETS.has(env("APP_JWT_SECRET"))) {
    missing.push("APP_JWT_SECRET (missing or set to a known default)");
  }
  if (!config.firebase.serviceAccountBase64 && !config.firebase.serviceAccountPath) {
    missing.push("FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT_PATH");
  }
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
}
