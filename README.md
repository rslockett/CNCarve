# CNCarve

Browser-based workflow for Kiri / GRBL. **Web Serial** (USB to the CNC) requires **Chrome or Edge** on a desktop OS and a **secure context** (HTTPS or localhost).

## Run locally

```bash
cd web
pnpm install
pnpm dev
```

Open the URL printed in the terminal (defaults to `http://127.0.0.1:3000`).

## CNCarve relief engine (one bit, recommended for reliefs)

For one-bit relief carving (icons, crosses, plaques) use **Setup → Carve with CNCarve engine**
(or **Carving jobs** in the toolbar) instead of importing into Kiri:Moto. The engine:

- removes wood in shallow layers before the detail pass, so a narrow V-bit is never buried
  at full depth (Kiri's one-bit contour cuts the whole depth in one pass);
- accounts for the bit's real shape so its sides never cut into neighbouring detail;
- splits the carving into short jobs (about 45 minutes or less) that can simply be re-run after a stop;
- simulates the carve and checks every line against stock GRBL 1.1 before you run anything.

Code lives in `web/src/lib/relief/`; `web/scripts/relief-cli.ts` runs the same engine from the
command line. After connecting, the machine panel also reads the GRBL settings (`$$`, read-only)
and flags problems such as laser mode left on or homing off.

## Deploy on Vercel (from this GitHub repo)

1. Push this repository to GitHub (see below).
2. In [Vercel](https://vercel.com): **Add New… → Project** → import `rslockett/CNCarve`.
3. Under **Root Directory**, set **`web`** (not the repo root). Vercel should detect **Next.js**.
4. **Build Command:** `pnpm run build` (or leave default — `web/vercel.json` pins this).
5. **Install Command:** leave **empty** / default so Vercel runs **`pnpm install`**. If the log ever shows `Running "install" command: pnpm run build`, open **Settings → General → Build & Development Settings**, clear the **Install Command** override, and redeploy. The committed `web/vercel.json` also forces `pnpm install --frozen-lockfile` when Root Directory is `web`.
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
