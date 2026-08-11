import dotenv from "dotenv";

dotenv.config();

const publicFirebase = {
  apiKey: process.env.PUBLIC_FIREBASE_API_KEY || "",
  authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || "",
  storageBucket: process.env.PUBLIC_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.PUBLIC_FIREBASE_APP_ID || ""
};

export const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.APP_JWT_SECRET || "dev-only-change-me",
  corsOrigin: process.env.CORS_ORIGIN || "",
  firebase: {
    serviceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "",
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
    projectId: process.env.FIREBASE_PROJECT_ID || publicFirebase.projectId || ""
  },
  publicFirebase,
  srAdminPin: process.env.SR_ADMIN_PIN || ""
};

export function requireProductionSecrets() {
  if (config.env !== "production") return;
  const missing = [];
  if (!process.env.APP_JWT_SECRET || process.env.APP_JWT_SECRET === "replace-with-a-long-random-secret") {
    missing.push("APP_JWT_SECRET");
  }
  if (!config.firebase.serviceAccountBase64 && !config.firebase.serviceAccountPath) {
    missing.push("FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT_PATH");
  }
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
}
