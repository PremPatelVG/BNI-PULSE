# BNI CHAPTER PULSE Go-Live Checklist

Use this checklist when moving BNI CHAPTER PULSE from local preview to live Netlify production.

## Current Launch Status

As of the latest local validation:

- Active chapters: `58`
- Login members/directors: `61`
- Local TLR rows: `58`
- Members Due records imported: `152`
- Members Due months: `2026-08 = 22`, `2026-09 = 130`
- Removed from system: Nachiket Patel and assigned chapters/team
- Area Directors with full region access: Yash Vasant, Snehal Patel
- All other leaders are scoped to their assigned Senior Director / Chapter Director access

## 1. Preflight Checks

Run these before every live deploy:

```powershell
npm install
npm run import:local-dues
npm run check
npm run build
```

Expected result:

- `npm run check` passes
- `npm run build` creates `dist`
- `local-dues-data.json` imports `152` members from the latest Members Due report
- Local preview opens without console-breaking errors

Local preview:

```text
http://127.0.0.1:3000/?preview=login&v=go-live-check
```

## 2. Firebase Production Requirements

Firestore must already contain:

- `chapters`
- `members`
- `meta/dues`
- `meta/tlr`
- Any dashboard meta documents used by the app

Important:

- Do not commit Firebase service account JSON to GitHub.
- Do not use `FIREBASE_SERVICE_ACCOUNT_PATH` on Netlify.
- Netlify must use `FIREBASE_SERVICE_ACCOUNT_BASE64`.

Convert the service account JSON to base64:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\Admin\Downloads\bnipulse-firebase-adminsdk-fbsvc-2c4376499e.json"))
```

Copy the full output into Netlify as `FIREBASE_SERVICE_ACCOUNT_BASE64`.

## 3. Netlify Environment Variables

Set these in Netlify:

Netlify dashboard > Site configuration > Environment variables

```text
NODE_ENV=production
APP_JWT_SECRET=<long-random-secret>
FIREBASE_SERVICE_ACCOUNT_BASE64=<base64-service-account-json>
FIREBASE_PROJECT_ID=bnipulse
PUBLIC_FIREBASE_API_KEY=<firebase-web-api-key>
PUBLIC_FIREBASE_AUTH_DOMAIN=bnipulse.firebaseapp.com
PUBLIC_FIREBASE_PROJECT_ID=bnipulse
PUBLIC_FIREBASE_STORAGE_BUCKET=bnipulse.firebasestorage.app
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=909749944828
PUBLIC_FIREBASE_APP_ID=1:909749944828:web:4b44fdcf3c3c3e97b27279
```

Generate `APP_JWT_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 4. Netlify Build Settings

These are already configured in `netlify.toml`:

```text
Build command: npm run build
Publish directory: dist
Functions directory: netlify/functions
```

Routes handled by Netlify Functions:

- `/api/*`
- `/config.js`
- `/healthz`

SPA fallback:

- `/*` redirects to `/index.html`

## 5. Data Import Before Launch

### Hierarchy

Only rerun this if director/chapter ownership changes:

```powershell
npm run import:hierarchy -- --file="C:/Users/Admin/Downloads/SRDC & DC CHAPTER WSIE.xlsx" --write=true --default-pin=1234
```

After import, verify:

- Only Yash Vasant and Snehal Patel have Area Director access
- Senior Directors only see assigned chapters
- Chapter Directors only see assigned chapter(s)
- Nachiket Patel team remains removed

### Members Due

Local import:

```powershell
npm run import:local-dues
```

Push the same cleaned dues data to live Firebase:

```powershell
node scripts/import-local-dues.js "C:\Users\Admin\Downloads\Region_Upcoming_Renewals_Report_14-08-2026_2-44_PM.xls" local-dues-data.json --write=true
```

Expected live count:

```text
members=152
chapters=39
2026-08=22
2026-09=130
```

### TLR

Local TLR file:

```powershell
npm run import:local-tlr
```

Before live launch, verify:

- All active chapters have a TLR row
- Chapter scorecards show TLR score
- TYFCB is populated
- Chapter scorecard totals are not blank

## 6. Deploy Flow

First check Netlify login/link status:

```powershell
npx netlify status
```

If not logged in:

```powershell
npx netlify login
```

If the repo is not linked to a Netlify site:

```powershell
npx netlify link
```

Recommended safe flow:

```powershell
npx netlify deploy
```

Test the preview deploy URL. If everything passes, deploy production:

```powershell
npx netlify deploy --prod
```

## 7. Production Smoke Test

After production deploy, test these URLs:

```text
https://<your-site>.netlify.app/healthz
https://<your-site>.netlify.app/config.js
https://<your-site>.netlify.app/
```

Then log in and check:

- Area Director dashboard loads
- Area Director filters work by chapter and Senior Director
- Cumulative Net Added dropdown works: 30 days, 60 days, 90 days, 6 months, 12 months
- Support Scorecard target shows `696` yearly and `174` quarterly
- Renewals tab shows Members Due data
- Renewals filters work: 30 days, 60 days, 90 days
- Marking a renewal done shows `Complete`
- Retention module shows this month, 3 months, 6 months, 12 months
- Senior Director sees only assigned chapters
- Chapter Director sees only assigned chapter(s)
- Reports tab chapter scorecards show data

## 8. Go / No-Go Decision

Go live only if all are true:

- `npm run check` passes
- `npm run build` passes
- Netlify preview deploy works
- `/healthz` returns healthy
- Login works for Area Director, Senior Director, and Chapter Director
- Live Firestore has current hierarchy and dues data
- Renewals and Retention screens show real data
- No sensitive `.env` or service account JSON is committed

No-go if:

- Login fails
- Firebase config is missing in `/config.js`
- Firestore permission/admin credential error appears
- Renewals or TLR dashboards are blank with live data
- Netlify Functions return 500 errors

## 9. Rollback Plan

If production has a problem:

1. Open Netlify dashboard.
2. Go to Deploys.
3. Select the last known good deploy.
4. Click publish deploy.
5. Confirm login and `/healthz`.

For bad data only:

- Do not redeploy code.
- Re-import the previous correct data file into Firebase.
- Confirm the dashboard updates after refresh.

## 10. Post-Launch Notes

After launch:

- Replace shared test PINs with real per-person PINs.
- Keep report layouts stable where possible.
- If Excel column names change, test import locally before pushing live.
- Save every monthly Members Due and TLR source file in a dated folder.
- Use preview deploys before every production deploy.
