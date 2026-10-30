# CNCarve

Browser-based workflow for Kiri / GRBL. **Web Serial** (USB to the CNC) requires **Chrome or Edge** on a desktop OS and a **secure context** (HTTPS or localhost).

## Run locally

```bash
cd web
pnpm install
pnpm dev
```

Open the URL printed in the terminal (defaults to `http://127.0.0.1:3000`).

## Simple carve (home page)

The home page walks through five steps: **choose an STL → board size and wood → size on the board
→ toolpaths (made automatically) → carve**. It is built for one-bit relief carving (icons,
crosses, plaques) on a 3018-PROVer.

- **Smart file handling:** the carved face is turned to point up automatically, the design is
  turned 90° when that fits it bigger, and "largest that fits" respects width, length and thickness.
- **One continuous carve:** shallow roughing layers, then the detail pass, in a single program,
  so there is no re-zeroing between files. Toolpaths account for the bit's real shape.
- **Machine control built in:** connect over USB (Chrome/Chromium), automatic settings check,
  home, set zero with the arrow pad (paper or touch probe), trace the outline with the spindle off,
  then carve with pause / resume / stop and a time-left estimate.
- **Recovery:** the program, the zero (`$#`) and progress are saved on the device. After a USB
  drop, stop, page reload or Pi reboot, **Continue carving** homes, checks the zero (restoring it
  if it changed), turns the spindle on above the work and restarts at a safe segment start a
  little before where it stopped.

The original Kiri:Moto workspace is at **`/advanced`**. Engine code: `web/src/lib/relief/`;
machine control: `web/src/lib/carveMachine.ts`, `web/src/lib/carveStore.ts`; screen:
`web/src/components/carve/`. `web/scripts/relief-cli.ts` runs the engine from the command line.

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
