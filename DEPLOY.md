# CODETRACK — Deployment Guide (Render)

CODETRACK is a Flask API + static frontend. On Render, **one web service serves both**:
the backend exposes `/`, `/styles.css`, `/script.js` (frontend) and `/api/*` (REST API).

## What's configured

| File | Purpose |
| --- | --- |
| `render.yaml` | Render Blueprint: free Python web service, gunicorn start command, generated secret, health check at `/api/health` |
| `.python-version` | Pins Python 3.13 (Render picks the latest 3.13.x patch) |
| `backend/requirements.txt` | Includes `gunicorn` for production |
| `.gitignore` + `backend/.gitignore` | Keeps `codetrack.db`, `.codetrack-secret`, `__pycache__`, `.env` out of Git |
| `script.js` | Uses same-origin `/api` when deployed; keeps `:5000/api` for local dev (Live Server / `file://`) |

## 1. Push to GitHub

```bash
git remote add origin https://github.com/<your-username>/codetrack.git
git push -u origin main
```

(Create the empty repo on github.com first — no README/license needed since the project already has files.)

## 2. Create the Render service

1. Sign in at [render.com](https://render.com) → **New +** → **Blueprint**.
2. Connect the GitHub repo. Render detects `render.yaml` automatically.
3. Click **Apply**. Render builds (`pip install -r backend/requirements.txt`) and starts
   `gunicorn backend.app:app --bind 0.0.0.0:$PORT`.
4. Your app is live at `https://<service-name>.onrender.com`.

## 3. After first deploy

- Open the service → **Environment** → update `CODETRACK_FRONTEND_URL` to your real URL
  (only used to build password-reset links).
- Optional email delivery: add `CODETRACK_SMTP_HOST`, `CODETRACK_SMTP_PORT`,
  `CODETRACK_SMTP_USER`, `CODETRACK_SMTP_PASSWORD`. Without them, reset links are
  printed in the server logs instead of being emailed.
- Every push to `main` redeploys automatically.

## Local development (unchanged)

- Backend: `python backend/app.py` → `http://127.0.0.1:5000`
- Frontend: Live Server on port 5500/5501/etc. `script.js` still targets `:5000/api`
  whenever the hostname is `localhost` / `127.0.0.1` / `file://`.

## Known caveats (Render free tier)

- **SQLite is ephemeral**: `backend/codetrack.db` lives on the instance disk and is
  wiped on redeploys/restarts. Guest/offline mode (browser `localStorage`) is unaffected.
  For durable accounts, attach a paid persistent disk or migrate to Render Postgres.
- Free instances spin down after inactivity; first request after idle takes ~30s.
