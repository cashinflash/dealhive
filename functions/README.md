# DealHive Cloud Functions

Nightly pipeline that pulls fresh wholesale + listing data from Apify
(InvestorLift scraper) and the RentCast Listings API, filters to residential
1–4 unit deals, classifies each, and writes to Firebase Realtime DB at `/deals`.
The React app reads from there.

## Deploy via GitHub Actions (recommended — no local CLI)

The `.github/workflows/deploy-firebase.yml` workflow deploys the functions and
DB rules for you on every push to `main`. You can also trigger it manually from
the GitHub Actions tab.

You do this **once**, all in a browser:

### 1. Upgrade Firebase to the Blaze plan

Cloud Functions with outbound HTTP requires Blaze (pay-as-you-go). At our
nightly volume the bill is typically a few cents per month.

→ https://console.firebase.google.com/project/darallc/usage/details
→ click **Modify plan** → **Blaze**.

### 2. Rotate the Apify API key

→ https://console.apify.com/account/integrations
→ revoke any keys you've previously pasted in chat
→ generate a new one and copy it (you'll paste it into GitHub in step 4)

### 3. Generate a Firebase service-account key

This lets the GitHub workflow authenticate as your Firebase project.

→ https://console.firebase.google.com/project/darallc/settings/serviceaccounts/adminsdk
→ click **Generate new private key** → confirm
→ a `darallc-firebase-adminsdk-xxxxx.json` file downloads — keep this file
   private and don't commit it to git

Then grant that service account the roles it needs to deploy and manage secrets:

→ https://console.cloud.google.com/iam-admin/iam?project=darallc
→ find the service account named `firebase-adminsdk-xxxxx@darallc.iam.gserviceaccount.com`
→ click the pencil to edit and add these roles:
  - **Cloud Functions Admin**
  - **Service Account User**
  - **Secret Manager Admin**
  - **Cloud Scheduler Admin** (needed because `pullDeals` is a scheduled function)
→ save

### 4. Add 4 secrets to the GitHub repo

→ https://github.com/cashinflash/dealhive/settings/secrets/actions
→ click **New repository secret** four times and add:

| Name                       | Value                                                            |
|----------------------------|------------------------------------------------------------------|
| `FIREBASE_SERVICE_ACCOUNT` | Open the JSON file from step 3, paste the **entire contents**    |
| `APIFY_API_KEY`            | The newly rotated Apify token from step 2                        |
| `RENTCAST_API_KEY`         | Your RentCast API key                                            |
| `MANUAL_TRIGGER_SECRET`    | Any random string (used by the manual-trigger endpoint as a passcode) |

### 5. Run the workflow

→ https://github.com/cashinflash/dealhive/actions/workflows/deploy-firebase.yml
→ click **Run workflow** → **Run workflow** (confirms)
→ wait ~3 minutes for it to go green

After this first run, any future push to `main` that touches `functions/`,
`database.rules.json`, or `firebase.json` deploys automatically.

### 6. Smoke-test the pipeline

Visit this URL in a browser, replacing `YOUR_SECRET` with whatever you set
for `MANUAL_TRIGGER_SECRET` in step 4:

```
https://us-central1-darallc.cloudfunctions.net/pullDealsNow?secret=YOUR_SECRET
```

You should get a JSON response showing how many deals were pulled from each
source and how many survived the residential + classification filter. Refresh
the Deals page on dealhive.io — the **Preview data** pill should flip to
**Live** with an "Updated 30s ago" timestamp.

## Skip tracing (Endato) — one-time key setup

The "Reveal Owner Phone" evaluation uses [Endato](https://endato.com) (the
developer API of Enformion). To plug in your account:

1. Sign in at endato.com → open the dashboard → **API Keys** (sometimes shown
   under your profile menu). You'll see a key **pair**: a Name (sometimes
   called Key ID) and a Password (Secret). Copy both.
2. → https://github.com/cashinflash/dealhive/settings/secrets/actions
   → **New repository secret** twice:

   | Name                 | Value                          |
   |----------------------|--------------------------------|
   | `ENDATO_AP_NAME`     | The key Name / ID              |
   | `ENDATO_AP_PASSWORD` | The key Password / Secret      |

3. Re-run the deploy workflow (step 5 above) so the keys reach Secret Manager.
4. Smoke-test against the live feed (same passcode as the pipeline trigger):

   ```
   https://us-central1-darallc.cloudfunctions.net/skipTraceTest?secret=YOUR_SECRET&n=15
   ```

   The JSON reports hit rate, connected-phone rate, and per-owner results.
   Each attempted lookup can consume one search from the Endato plan, and `n`
   is capped at 25 per run.

## Tuning daily pull volume

Defaults are tuned for "Conservative ~200 deals/day":
- Apify InvestorLift: 50 raw / day
- RentCast: 25 / market × 6 markets = 150 raw / day

To change, edit the top of `index.js` and push to main:
```js
const INVESTORLIFT_MAX        = parseInt(process.env.INVESTORLIFT_MAX        || "50", 10);
const RENTCAST_MAX_PER_MARKET = parseInt(process.env.RENTCAST_MAX_PER_MARKET || "25", 10);
```

Cost watchouts:
- **RentCast** counts each returned record as 1 API credit. 150/day ≈ 4,500/mo
  (Premier plan, $200/mo). Drop `RENTCAST_MAX_PER_MARKET` to 10 to fit Pro
  ($50/mo, 1,000 records).
- **Apify** charges per compute unit. `enrichWithDetails: true` doubles the
  cost per deal but is what surfaces photos + seller contact. Set it to `false`
  in `mapApifyDeal`'s call if budget bites.

## Watching logs

→ https://console.firebase.google.com/project/darallc/functions/logs

Filter by function name (`pullDeals` for the scheduled runs, `pullDealsNow`
for manual triggers). Each successful run logs a summary like
`✓ Wrote 187 deals (raw 203) { investorlift: 47, rentcast: 156 }`.

## Safety net

If both sources return zero on a given run (Apify scraper went stale, RentCast
quota maxed), the pipeline **logs and exits without writing** — yesterday's
deals stay live rather than blanking the page. Watch the logs after each
nightly run for the first week to catch this early.

## Local CLI (only if you ever want to deploy from a laptop)

Skip this entire section if you're using the GitHub Actions path above.

```sh
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
firebase functions:secrets:set APIFY_API_KEY
firebase functions:secrets:set RENTCAST_API_KEY
firebase functions:secrets:set MANUAL_TRIGGER_SECRET
firebase deploy --only database,functions
```
