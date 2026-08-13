import fs from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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

export function getFirebaseAdmin() {
  if (!getApps().length) {
    const serviceAccount = readServiceAccount();
    if (serviceAccount) {
      initializeApp({
        credential: cert(serviceAccount),
        projectId: config.firebase.projectId || serviceAccount.project_id
      });
    } else {
      initializeApp({
        projectId: config.firebase.projectId || undefined
      });
    }
  }

  return getApps()[0];
}

export function getDb() {
  getFirebaseAdmin();
  return getFirestore();
}
