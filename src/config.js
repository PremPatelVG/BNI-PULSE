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

export const config = {
  env: env("NODE_ENV") || "development",
  port: Number(env("PORT") || 3000),
  jwtSecret: env("APP_JWT_SECRET") || "dev-only-change-me",
  corsOrigin: env("CORS_ORIGIN"),
  firebase: {
    serviceAccountBase64: env("FIREBASE_SERVICE_ACCOUNT_BASE64"),
    serviceAccountPath: env("FIREBASE_SERVICE_ACCOUNT_PATH"),
    projectId: env("FIREBASE_PROJECT_ID") || publicFirebase.projectId || ""
  },
  publicFirebase,
  srAdminPin: env("SR_ADMIN_PIN")
};

export function requireProductionSecrets() {
  if (config.env !== "production") return;
  const missing = [];
  if (!env("APP_JWT_SECRET") || env("APP_JWT_SECRET") === "replace-with-a-long-random-secret") {
    missing.push("APP_JWT_SECRET");
  }
  if (!config.firebase.serviceAccountBase64 && !config.firebase.serviceAccountPath) {
    missing.push("FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT_PATH");
  }
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
}
