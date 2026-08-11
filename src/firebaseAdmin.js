import fs from "node:fs";
import admin from "firebase-admin";
import { config } from "./config.js";

function readServiceAccount() {
  if (config.firebase.serviceAccountBase64) {
    const decoded = Buffer.from(config.firebase.serviceAccountBase64, "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  if (config.firebase.serviceAccountPath) {
    return JSON.parse(fs.readFileSync(config.firebase.serviceAccountPath, "utf8"));
  }

  return null;
}

let initialized = false;

export function getFirebaseAdmin() {
  if (!initialized) {
    const serviceAccount = readServiceAccount();
    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: config.firebase.projectId || serviceAccount.project_id
      });
    } else {
      admin.initializeApp({
        projectId: config.firebase.projectId || undefined
      });
    }
    initialized = true;
  }

  return admin;
}

export function getDb() {
  return getFirebaseAdmin().firestore();
}
