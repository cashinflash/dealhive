# DealHive Cloud Functions

Nightly pipeline that pulls fresh wholesale + listing data from Apify
(InvestorLift scraper) and the RentCast Listings API, filters to residential
1–4 unit deals, classifies each, and writes to Firebase Realtime DB at `/deals`.
The React app reads from there.

## One-time setup (you do this once)

### 1. Upgrade Firebase to the Blaze plan

Cloud Functions with outbound HTTP requires the Blaze (pay-as-you-go) plan.
At our nightly volume the bill is typically a few cents/month.

→ https://console.firebase.google.com/project/darallc/usage/details

### 2. Install the Firebase CLI locally (one time, per machine)

```sh
npm install -g firebase-tools
firebase login
```

### 3. Install function dependencies

```sh
cd functions
npm install
cd ..
```

### 4. Set the secrets (one time, stored in Google Secret Manager)

```sh
firebase functions:secrets:set APIFY_API_KEY         # paste your rotated Apify key
firebase functions:secrets:set RENTCAST_API_KEY      # paste your RentCast key
firebase functions:secrets:set MANUAL_TRIGGER_SECRET # any random string for the /pullDealsNow endpoint
```

### 5. Deploy DB rules + functions

```sh
firebase deploy --only database,functions
```

You should see two functions deployed:
- `pullDeals`     — scheduled, nightly 6am ET
- `pullDealsNow`  — HTTPS, manual trigger for testing

### 6. Smoke-test the pipeline

Replace `XXXX` with the value you set for `MANUAL_TRIGGER_SECRET`:

```sh
curl "https://us-central1-darallc.cloudfunctions.net/pullDealsNow?secret=XXXX"
```

Response shows how many deals were pulled per source and how many survived the
residential + classification filters. Refresh the Deals page in the app —
real deals should replace the sample cards.

## Tuning daily pull volume

Defaults are tuned for "Conservative ~200 deals/day":
- Apify InvestorLift: 50 raw / day
- RentCast: 25 / market × 6 markets = 150 raw / day

To change without redeploying secrets, edit the top of `index.js`:
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

```sh
firebase functions:log --only pullDeals
firebase functions:log --only pullDealsNow --lines 50
```

Or in the console: https://console.firebase.google.com/project/darallc/functions/logs

## Safety net

If both sources return zero on a given run (Apify scraper went stale, RentCast
quota maxed), the pipeline **logs and exits without writing** — yesterday's
deals stay live rather than blanking the page. Watch the logs after each
nightly run for the first week to catch this early.
