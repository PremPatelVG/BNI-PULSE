# BNI PULSE

BNI Pulse is a single-service deployment for the BNI Argonauts dashboard. It serves the existing frontend and adds a Node/Express backend for authentication, Firestore access, runtime Firebase config, and deployment health checks.

## Role hierarchy

The app now supports a regional leadership hierarchy:

- `ad`: Area Director. Region-level access across every chapter.
- `srdc`: Senior Director. Oversees assigned Chapter Directors and chapters.
- `dc`: Chapter Director. This is the shared CD/DC role used for chapter ownership.
- `sa1` / `sa2`: Chapter support roles.
- `viewer`: Read-only regional view.

Members can include `chapters`, `chapter`, and `reportsTo` fields. The UI treats CD and DC as the same role and stores it as `dc`.

The current seed hierarchy is based on `SRDC & DC CHAPTER WSIE.xlsx`:

- 62 chapters
- 9 Senior Directors
- 55 unique Chapter Directors / DCs
- 2 Area Directors: Yash Vasant and Snehal Patel

## Import real hierarchy

Use the workbook with columns `Chapter Region`, `Team`, `Chapter Name`, `SRDC`, `DC`, and `Meeting Day`.

Dry run:

```bash
npm run import:hierarchy -- --file="C:/Users/Admin/Downloads/SRDC & DC CHAPTER WSIE.xlsx"
```

Import into Firestore:

```bash
npm run import:hierarchy -- --file="C:/Users/Admin/Downloads/SRDC & DC CHAPTER WSIE.xlsx" --write=true --default-pin=1234
```

Before running the write command, configure Firebase Admin credentials with `FIREBASE_SERVICE_ACCOUNT_BASE64` or `FIREBASE_SERVICE_ACCOUNT_PATH`. The importer writes `chapters` and `members`, stores imported PINs as bcrypt hashes, and keeps CD/DC as role `dc`.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

For a beginner-friendly Firebase setup walkthrough, see [docs/FIREBASE_BEGINNER_SETUP.md](docs/FIREBASE_BEGINNER_SETUP.md).

## Required deployment variables

Set these in your hosting provider:

- `APP_JWT_SECRET`: long random string used to sign backend sessions.
- `FIREBASE_SERVICE_ACCOUNT_BASE64`: base64-encoded Firebase service-account JSON. You can use `FIREBASE_SERVICE_ACCOUNT_PATH` instead for local servers.
- `PUBLIC_FIREBASE_API_KEY`
- `PUBLIC_FIREBASE_AUTH_DOMAIN`
- `PUBLIC_FIREBASE_PROJECT_ID`
- `PUBLIC_FIREBASE_STORAGE_BUCKET`
- `PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `PUBLIC_FIREBASE_APP_ID`

Optional:

- `PORT`: defaults to `3000`.
- `CORS_ORIGIN`: comma-separated allowed origins. Leave blank while the backend and frontend are served by the same app.
- `SR_ADMIN_PIN`: first-run fallback only if `meta/config.srPin` has not been created.

## Backend endpoints

- `GET /healthz`: deployment health check.
- `GET /config.js`: browser Firebase config generated from environment variables.
- `POST /api/auth/login`: login with `{ "memberId": "...", "pin": "..." }`.
- `GET /api/auth/me`: validate a bearer token.
- `GET /api/bootstrap`: load dashboard data.
- `GET /api/hierarchy`: load Area Directors, Senior Directors, Chapter Directors, and chapter ownership.
- `GET /api/chapters`, `POST /api/chapters`
- `GET /api/members`, `POST /api/members`, `DELETE /api/members/:id`
- `GET /api/weekly-data`, `PUT /api/weekly-data/:chapter/:date`, `DELETE /api/weekly-data/:chapter/:date`
- `GET /api/meta/:docId`, `PUT /api/meta/:docId`

The backend never returns member PINs. New member PINs sent through the API are stored as bcrypt hashes.

## Deployment

This repo is now ready for Netlify with a static frontend and serverless backend.

Build command:

```bash
npm run build
```

Publish directory:

```text
dist
```

Netlify Functions directory:

```text
netlify/functions
```

The frontend remains `index.html`. The secure backend runs through Netlify Functions:

- `/config.js`
- `/healthz`
- `/api/*`

Set production environment variables in Netlify, not in Git:

- `NODE_ENV=production`
- `APP_JWT_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `FIREBASE_PROJECT_ID`
- `PUBLIC_FIREBASE_API_KEY`
- `PUBLIC_FIREBASE_AUTH_DOMAIN`
- `PUBLIC_FIREBASE_PROJECT_ID`
- `PUBLIC_FIREBASE_STORAGE_BUCKET`
- `PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `PUBLIC_FIREBASE_APP_ID`

Local Express development still works:

```bash
npm start
```
