# CNCarve

Browser-based workflow for Kiri / GRBL. **Web Serial** (USB to the CNC) requires **Chrome or Edge** on a desktop OS and a **secure context** (HTTPS or localhost).

## Run locally

```bash
cd web
pnpm install
pnpm dev
```

Open the URL printed in the terminal (defaults to `http://127.0.0.1:3000`).

## Deploy on Vercel (from this GitHub repo)

1. Push this repository to GitHub (see below).
2. In [Vercel](https://vercel.com): **Add New… → Project** → import `rslockett/CNCarve`.
3. Under **Root Directory**, set **`web`** (not the repo root). Vercel should detect **Next.js**.
4. **Build Command:** `pnpm run build` (default when lockfile is `pnpm-lock.yaml` in `web/`).
5. **Install Command:** leave default (`pnpm install`, or `corepack enable && pnpm install` if prompted).
6. Deploy. Your production URL is HTTPS, which satisfies Web Serial when you use the hosted app from Windows.

Optional: set **`NEXT_PUBLIC_KIRI_URL`** in Vercel → Project → Environment Variables if you host Kiri elsewhere; otherwise the app uses `https://grid.space/kiri/`.

## Push to GitHub

```bash
git remote add origin https://github.com/rslockett/CNCarve.git
# if origin already exists: git remote set-url origin https://github.com/rslockett/CNCarve.git
git add -A
git status
git commit -m "Initial CNCarve web app"
git push -u origin main
```

Use a [personal access token](https://github.com/settings/tokens) or SSH if GitHub rejects password auth.
