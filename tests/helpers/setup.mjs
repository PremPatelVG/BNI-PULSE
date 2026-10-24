// Loaded before every test file (node --import). Makes the tests hermetic:
//  - src/firebaseAdmin.js is replaced by the in-memory fake (no live database, ever);
//  - configuration comes from fixed test values, not the developer's .env (dotenv never
//    overrides a variable that is already set, even to an empty string).
import { register } from "node:module";

Object.assign(process.env, {
  NODE_ENV: "test",
  APP_JWT_SECRET: "unit-test-secret",
  LOCAL_PREVIEW_PIN: "",
  SR_ADMIN_PIN: "",
  FIREBASE_SERVICE_ACCOUNT_PATH: "",
  FIREBASE_SERVICE_ACCOUNT_BASE64: "",
  FIREBASE_PROJECT_ID: "unit-test",
  SNAPSHOT_CACHE_MS: "300000"
});

register(new URL("./hooks.mjs", import.meta.url), {
  data: { fakeUrl: new URL("./fake-firestore.mjs", import.meta.url).href }
});
