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
  --port 8080
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
  --port 8080
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
- Environment: `NODE_ENV=production` is set in Cloud Run

### Rollback to Previous Version
```bash
# Re-deploy a prior image (adjust tag/digest as needed)
gcloud run deploy arxcafe \
  --image europe-west1-docker.pkg.dev/my-project-5640-1765674689812/arxcafe/arxcafe:latest \
  --region europe-west1
```

### View Logs
```bash
gcloud run logs read arxcafe --region europe-west1 --limit 50
```

### List All Deployments
```bash
gcloud run revisions list --service arxcafe --region europe-west1
```

---

## Tech Stack (Quick Reference)
- Runtime: Node.js 18 (Docker base `node:18-slim`)
- Frontend: Vanilla HTML/CSS/JS; client routing via `api.html?api=slug`
- Backend: Minimal HTTP server in `server.js` (no Express), static asset serving
- Data: Google Trends via `google-trends-api` with cached results
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
gcloud run logs read arxcafe --region europe-west1 --limit 50

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
gcloud run logs read arxcafe --region europe-west1 --limit 100
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
