# Firebase Beginner Setup Guide for BNI Pulse

This guide shows how to create your own Firebase project, connect it to BNI Pulse, and import the Director/Senior Director chapter hierarchy.

## What Firebase Will Store

BNI Pulse uses Firebase Firestore as the database.

It will store:

- Area Directors
- Senior DCs
- DC / Chapter Directors
- Chapters
- Uploaded report data
- Dashboard settings
- Login records with hashed PINs

It will not store plain text PINs.

## Step 1: Create a Firebase Project

1. Open the Firebase Console:

   https://console.firebase.google.com/

2. Click **Add project**.
3. Project name:

   ```text
   BNI Pulse
   ```

4. Google Analytics can be disabled for now.
5. Finish creating the project.

## Step 2: Create the Firestore Database

1. Inside your Firebase project, open **Build > Firestore Database**.
2. Click **Create database**.
3. Choose **Production mode**.
4. Choose the closest region.
5. Finish setup.

For now, the backend uses Firebase Admin credentials, so the server can read and write Firestore securely.

## Step 3: Add a Firebase Web App

The web app config is public and is used by the dashboard frontend.

1. In Firebase, open **Project settings**.
2. Under **Your apps**, click the web icon: `</>`.
3. App nickname:

   ```text
   BNI Pulse Web
   ```

4. Do not enable Firebase Hosting here yet.
5. Click **Register app**.
6. Firebase will show a config like this:

   ```js
   const firebaseConfig = {
     apiKey: "xxxxx",
     authDomain: "xxxxx.firebaseapp.com",
     projectId: "xxxxx",
     storageBucket: "xxxxx.appspot.com",
     messagingSenderId: "xxxxx",
     appId: "xxxxx"
   };
   ```

Copy those values. They go into your `.env` file.

## Step 4: Create the Local `.env` File

In the project folder, copy the example file:

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in these values:

```env
NODE_ENV=development
PORT=3000
APP_JWT_SECRET=replace-this-with-a-generated-secret
CORS_ORIGIN=

FIREBASE_SERVICE_ACCOUNT_BASE64=
FIREBASE_SERVICE_ACCOUNT_PATH=
FIREBASE_PROJECT_ID=your-project-id

PUBLIC_FIREBASE_API_KEY=your-api-key
PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
PUBLIC_FIREBASE_PROJECT_ID=your-project-id
PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
PUBLIC_FIREBASE_APP_ID=your-app-id

SR_ADMIN_PIN=
```

Generate a secure session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put that generated value into:

```env
APP_JWT_SECRET=generated-value-here
```

## Step 5: Create Firebase Admin Credentials

The backend scripts need private Firebase Admin credentials.

1. Firebase Console > **Project settings**.
2. Open **Service accounts**.
3. Click **Generate new private key**.
4. Download the JSON file.
5. Save it somewhere safe on your computer.

For local setup, use the file path in `.env`:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=C:/Users/Admin/Downloads/bni-pulse-service-account.json
```

Important: do not commit the service account JSON file to GitHub.

## Step 6: Install and Test the Project

Install dependencies:

```powershell
npm install
```

Check the code:

```powershell
npm run check
```

Start the app:

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

Check the backend health URL:

```text
http://localhost:3000/healthz
```

If it says the app is healthy, the backend is running.

## Step 7: Test the Hierarchy Import Without Writing Data

First run a dry run. This checks the Excel sheet without changing Firebase.

```powershell
npm run import:hierarchy -- --file="C:/Users/Admin/Downloads/SRDC & DC CHAPTER WSIE.xlsx"
```

Expected result:

```text
Chapters: 62
Area Directors: 2
Senior Directors: 9
Chapter Directors/DCs: 55
Mode: dry-run
```

## Step 8: Import the Real Hierarchy Into Firestore

When the dry run looks correct, run the real import:

```powershell
npm run import:hierarchy -- --file="C:/Users/Admin/Downloads/SRDC & DC CHAPTER WSIE.xlsx" --write=true --default-pin=1234
```

This creates:

- Chapter records
- Area Director login records
- Senior DC login records
- DC / Chapter Director login records

The `--default-pin=1234` value is only an initial PIN. Change it later before real launch.

## Step 9: Check Data in Firebase

Go to Firebase Console > **Firestore Database**.

You should see collections like:

- `chapters`
- `members`
- `meta`

Open `members` and confirm that Area Directors, Senior DCs, and DCs were created.

Open `chapters` and confirm that all chapters were created.

## Step 10: Prepare for Deployment

For deployment, do not use `FIREBASE_SERVICE_ACCOUNT_PATH`. A hosted server cannot read a file from your computer.

Instead, convert the service account JSON into base64:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\Admin\Downloads\bni-pulse-service-account.json"))
```

Copy the output and set it as:

```env
FIREBASE_SERVICE_ACCOUNT_BASE64=the-long-base64-value
```

In your hosting provider, add all required environment variables:

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

## Common Problems

### Problem: Firebase permission error

Check that `FIREBASE_SERVICE_ACCOUNT_PATH` points to the correct JSON file.

### Problem: Dashboard says Firebase config is missing

Check all `PUBLIC_FIREBASE_*` values in `.env`.

### Problem: Import command does nothing

Make sure you added:

```text
--write=true
```

Without that, the importer only does a dry run.

### Problem: App fails in production

Check these variables first:

- `APP_JWT_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `FIREBASE_PROJECT_ID`

## Recommended Launch Order

1. Create Firebase project.
2. Add Firestore.
3. Add Firebase web app config to `.env`.
4. Add Firebase Admin service account to `.env`.
5. Run `npm run check`.
6. Run hierarchy dry run.
7. Run hierarchy write import.
8. Confirm Firestore data.
9. Deploy backend/frontend.
10. Upload real TLR, Members Due, and Miyagi reports.
