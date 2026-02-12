# ArxCafe Deployment Guide

## Quick Deploy to Google Cloud Run

### Prerequisites
- `gcloud` CLI installed and authenticated: `gcloud auth login`
- GCP project ID: `my-project-5640-1765674689812`
- Cloud Run and Cloud Build APIs enabled (one-time setup)

### One-Time Setup
```bash
gcloud config set project my-project-5640-1765674689812
gcloud config set run/region europe-west1
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
```

### MongoDB Atlas (Recommended): Static Egress IP for Cloud Run

Your Atlas allowlist cannot use your home IP when running on Cloud Run. The recommended approach is:
1) Give Cloud Run a static outbound IP via Serverless VPC Access + Cloud NAT
2) Add that single IP (`/32`) to the Atlas Network Access allowlist

#### One-time: create static egress IP + VPC connector + NAT (europe-west1)
```bash
# APIs (one-time)
gcloud services enable compute.googleapis.com vpcaccess.googleapis.com

# Reserve a static regional IP for NAT
gcloud compute addresses create arxcafe-egress-ip --region=europe-west1

# Create Serverless VPC Access connector (pick a /28 that doesn't overlap your VPC)
gcloud compute networks vpc-access connectors create arxcafe-connector \
  --region=europe-west1 \
  --network=default \
  --range=10.8.0.0/28

# Create router + NAT using the reserved IP
gcloud compute routers create arxcafe-router --network=default --region=europe-west1

gcloud compute routers nats create arxcafe-nat \
  --router=arxcafe-router \
  --region=europe-west1 \
  --nat-external-ip-pool=arxcafe-egress-ip \
  --nat-all-subnet-ip-ranges

# Print the egress IP to allowlist in Atlas
gcloud compute addresses describe arxcafe-egress-ip --region=europe-west1 --format='get(address)'
```

#### Update Cloud Run to use the connector (pins egress)
For an existing service:
```bash
gcloud run services update arxcafe \
  --region europe-west1 \
  --vpc-connector arxcafe-connector \
  --vpc-egress all-traffic
```

For a new deploy, include these flags in `gcloud run deploy`:
- `--vpc-connector arxcafe-connector`
- `--vpc-egress all-traffic`

#### Atlas allowlist
Add the printed IP as `x.x.x.x/32` in Atlas: **Network Access → IP Access List**.

### Deploy Steps (Recommended: Artifact Registry in europe-west1)

#### 1. Enable Artifact Registry (one-time)
```bash
gcloud services enable artifactregistry.googleapis.com
```

#### 2. Ensure repo exists and grant Cloud Run pull access (one-time)
```bash
# Create region-local repo (skip if it already exists)
gcloud artifacts repositories create arxcafe \
  --repository-format=docker \
  --location=europe-west1 \
  --description="Docker repo for arxcafe"

# Allow Cloud Run service account to read images
gcloud artifacts repositories add-iam-policy-binding arxcafe \
  --location=europe-west1 \
  --member=serviceAccount:832624474718-compute@developer.gserviceaccount.com \
  --role=roles/artifactregistry.reader
```

#### 3. Build & Push image to Artifact Registry (AR)
```bash
gcloud builds submit --tag \
europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:latest
```

#### 4. Deploy to Cloud Run from AR
```bash
gcloud run deploy arxcafe \
  --image europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:latest \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --vpc-connector arxcafe-connector \
  --vpc-egress all-traffic
```

### Production Environment Variables (Required)

Cloud Run does not automatically set `NODE_ENV=production`. For secure session cookies and production DB routing, set it explicitly.

Minimum required variables for production:
- `NODE_ENV=production`
- `MONGO_PROD_URI=...`
- `SESSION_SECRET=...` (strong random secret)

If you enable paid access:
- `STRIPE_SECRET_KEY=...`
- `STRIPE_PUBLISHABLE_KEY=...`
- `STRIPE_PRICE_ID=...`
- `STRIPE_WEBHOOK_SECRET=...`

If you enable AI explanations:
- `GEMINI_API_KEY=...`
- `AI_ASSIST_MODEL=gemini-2.5-flash`

If you enable "Forgot password" emails:
- `PUBLIC_BASE_URL=https://arxcafe.com` (optional; otherwise derived from request host)
- `SMTP_HOST=...`
- `SMTP_PORT=587` (or `465` for implicit TLS)
- `SMTP_SECURE=false` (set `true` for implicit TLS)
- `SMTP_USER=...` (optional; depends on your SMTP)
- `SMTP_PASS=...` (optional; depends on your SMTP)
- `SMTP_FROM="ArxCafe <no-reply@arxcafe.com>"`

#### Option A: set env vars directly (quick)
```bash
gcloud run services update arxcafe \
  --region europe-west1 \
  --set-env-vars NODE_ENV=production \
  --set-env-vars MONGO_PROD_URI="mongodb+srv://..." \
  --set-env-vars SESSION_SECRET="..." \
  --set-env-vars GEMINI_API_KEY="..." \
  --set-env-vars AI_ASSIST_MODEL=gemini-2.5-flash \
  --set-env-vars STRIPE_SECRET_KEY="..." \
  --set-env-vars STRIPE_PUBLISHABLE_KEY="..." \
  --set-env-vars STRIPE_PRICE_ID="..." \
  --set-env-vars STRIPE_WEBHOOK_SECRET="..."
```

#### Option B: use Secret Manager (recommended)
Create secrets:
```bash
printf "%s" "your-session-secret" | gcloud secrets create arxcafe-session-secret --data-file=-
printf "%s" "your-mongo-uri"       | gcloud secrets create arxcafe-mongo-prod-uri  --data-file=-
printf "%s" "your-gemini-key"      | gcloud secrets create arxcafe-gemini-api-key  --data-file=-
printf "%s" "your-stripe-secret"   | gcloud secrets create arxcafe-stripe-secret   --data-file=-
printf "%s" "your-stripe-webhook"  | gcloud secrets create arxcafe-stripe-webhook  --data-file=-
```

Attach secrets to the service:
```bash
gcloud run services update arxcafe \
  --region europe-west1 \
  --set-env-vars NODE_ENV=production \
  --set-secrets SESSION_SECRET=arxcafe-session-secret:latest \
  --set-secrets MONGO_PROD_URI=arxcafe-mongo-prod-uri:latest \
  --set-secrets GEMINI_API_KEY=arxcafe-gemini-api-key:latest \
  --set-secrets STRIPE_SECRET_KEY=arxcafe-stripe-secret:latest \
  --set-secrets STRIPE_WEBHOOK_SECRET=arxcafe-stripe-webhook:latest
```

#### 1. Build & Push Image to Google Container Registry
```bash
gcloud builds submit --tag gcr.io/my-project-5640-1765674689812/arxcafe:latest
```
This builds the Docker image and pushes it to GCR. Takes ~40 seconds.

#### 2. Deploy to Cloud Run
```bash
gcloud run deploy arxcafe \
  --image gcr.io/my-project-5640-1765674689812/arxcafe:latest \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --vpc-connector arxcafe-connector \
  --vpc-egress all-traffic
```

#### 3. Verify Deployment
Service URL: https://arxcafe-832624474718.europe-west1.run.app  
Custom domain: https://arxcafe.com

### Custom Domain (Already Configured)
Domain mappings are already set up:
- `arxcafe.com` → arxcafe service
- `www.arxcafe.com` → arxcafe service

To view current mappings:
```bash
gcloud beta run domain-mappings list --region europe-west1
```

### Important Notes
- All static assets (`.jpg`, `.png`, `.css`, `.js`) in the root directory are served via the server
- Ensure `srebrenik.jpg` is in the project root before deploying
- The server listens on port 8080 (as configured in `server.js` and Dockerfile)
- Cloud Run: set `NODE_ENV=production` explicitly (see above)

### Rollback to Previous Version
```bash
# Re-deploy a prior image (adjust tag/digest as needed)
gcloud run deploy arxcafe \
  --image europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:latest \
  --region europe-west1
```

### View Logs
```bash
gcloud run services logs read arxcafe --region europe-west1 --limit 50
```

### List All Deployments
```bash
gcloud run revisions list --service arxcafe --region europe-west1
```

---

## Tech Stack (Quick Reference)
- Runtime: Node.js 18 (Docker base `node:18-slim`)
- Frontend: Vanilla HTML/CSS/JS; client routing via `api.html?api=slug`
- Backend: Express app in `server.js` (sessions + Passport auth + Stripe + Gemini routes)
- Data: Google Trends via `google-trends-api` with cached results
- Data (ML topics, dev only): MongoDB local instance (Compass) for storing/searching Professional ML Engineer topics
- Container: Docker single-stage; Cloud Run (managed) in `europe-west1`
- Registry: Artifact Registry (AR) in `europe-west1`

## Data Access & Endpoints
- `GET /`: homepage ([index.html](index.html))
- `GET /api?api=<slug>`: API detail page ([api.html](api.html)); backgrounds:
  - AWS → `blagaj.jpg`
  - Google Cloud → `srebrenik.jpg`
  - Cloudflare → `stolac.jpg`
- `GET /trends.json`: live exam trends sourced from Google Trends
  - Keywords: defined in `server.js` (`trendKeywords`)
  - Cache TTL: 6 hours (`CACHE_TTL_MS`)
  - Lookback: 30 days (`LOOKBACK_DAYS`)
  - Method: average interest over time per keyword
  - Edit keywords and redeploy to change results
- `GET /ml-topics.json?q=<query>`: search stored ML topics related to the Professional Machine Learning Engineer card (dev only)
  - Backend collection: `ml_topics` in local MongoDB `arxcafe`
  - Document shape (example): `{ section: "Framing Machine Learning Problems", sectionOrder: 1, order: 1, text: "When to use ML vs non-ML" }`
  - Notes: you can manage/seed this collection via MongoDB Compass in your local dev environment

## Cost Control
- Use AR in `europe-west1` (done); avoid cross-region pulls
- Keep only 1–2 images (latest + optional previous) to minimize storage
- Scale-to-zero: default Cloud Run behavior; pay only when serving
- Logs: monitor volumes; set budgets/alerts in Billing

### GCR Cleanup (Historical)
If any old images remain in GCR, remove them:
```bash
# List digests
gcloud container images list --repository gcr.io/my-project-5640-1765674689812
gcloud container images list-tags gcr.io/my-project-5640-1765674689812/arxcafe \
  --format='get(digest,tags,timestamp.datetime)'

# Delete specific digests/tags (replace with actual digests)
gcloud container images delete gcr.io/my-project-5640-1765674689812/arxcafe@sha256:<digest> --quiet
gcloud container images delete gcr.io/my-project-5640-1765674689812/arxcafe:latest --force-delete-tags --quiet
```

## Verification & Ops
```bash
# Services in region
gcloud run services list --platform managed --region europe-west1

# Describe service (image, limits, URLs)
gcloud run services describe arxcafe --platform managed --region europe-west1 --format=json

# Domain mappings
gcloud beta run domain-mappings list --region europe-west1

# Logs
gcloud run services logs read arxcafe --region europe-west1 --limit 50

# Billing link
gcloud beta billing projects describe my-project-5640-1765674689812
```

---

## Runbook

### Routine Deploy
```bash
gcloud builds submit --tag \
europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:latest

gcloud run deploy arxcafe \
  --image europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:latest \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --port 8080
```

### Rollback
```bash
# Re-deploy a previous image (replace tag/digest)
gcloud run deploy arxcafe \
  --image europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:<tag-or-digest> \
  --region europe-west1
```

### Health & Status
```bash
# Describe service (URLs, image, limits)
gcloud run services describe arxcafe --platform managed --region europe-west1 --format=json

# Quick HTTP check
curl -I https://arxcafe.com
curl -I https://arxcafe-832624474718.europe-west1.run.app
```

### Logs
```bash
gcloud run services logs read arxcafe --region europe-west1 --limit 100
```

### Domain & TLS
```bash
gcloud beta run domain-mappings list --region europe-west1
gcloud beta run domain-mappings describe arxcafe.com --region europe-west1 --format=yaml
```

### Cost Controls
```bash
# Verify billing link
gcloud beta billing projects describe my-project-5640-1765674689812

# (Optional) set budgets/alerts via Cloud Console → Billing → Budgets
```

### Image Hygiene
```bash
# List AR images
gcloud artifacts docker images list \
  europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe

# Delete old tags/digests (replace <tag-or-digest>)
gcloud artifacts docker images delete \
  europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe@sha256:<digest> --quiet
```

### Static Assets
- Place hero images at project root (served by server):
  - AWS → `blagaj.jpg`
  - Google Cloud → `srebrenik.jpg`
  - Cloudflare → `stolac.jpg`
- Confirm mappings in [api.html](api.html) CATALOG entries.

### Troubleshooting
- 404 for images: ensure files exist at root and redeploy.
- Service not responding: check logs; verify port `8080` and `EXPOSE 8080` in Dockerfile.
- Trends not loading: confirm `/trends.json` and internet egress; inspect `google-trends-api` calls in [server.js](server.js).
