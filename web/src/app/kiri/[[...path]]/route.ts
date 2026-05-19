/**
 * Reverse-proxy for Kiri:Moto assets served from grid.space.
 *
 * Serving Kiri from our own origin makes the iframe same-origin with the parent
 * window, which lets us inject a SharedArrayBuffer polyfill into the HTML before
 * Kiri's init code runs. Without that polyfill, Kiri sees
 * `self.SharedArrayBuffer === undefined` and marks every contour/lathe operation
 * as disabled — which is the bug we're fixing.
 *
 * The polyfill sets `window.SharedArrayBuffer = window.ArrayBuffer` so Kiri's
 * `hasSharedArrays` / `O6` flags evaluate to true. Kiri does not use Atomics, so
 * the ArrayBuffer stand-in is functionally equivalent for its purposes.
 */

import { type NextRequest, NextResponse } from "next/server";

// Headers we must strip from the upstream response.
const STRIP_RESPONSE_HEADERS = new Set([
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  // We decode the body before re-serving it, so encoding headers no longer apply.
  "content-encoding",
  "transfer-encoding",
]);

// <base> keeps relative URLs (index.css, manifest.json) working even when the
// browser lands on /kiri (no trailing slash) after Next.js's 308 redirect.
const BASE_TAG = '<base href="/kiri/">';
// Use `self` (not `window`) so the same string also works inside Web Workers
// when prepended to JS files served by the /lib/ route handler.
const SAB_POLYFILL =
  '<script>if(typeof SharedArrayBuffer==="undefined"){self.SharedArrayBuffer=self.ArrayBuffer;}</script>';

export const dynamic = "force-dynamic";

async function handler(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;

  const upstreamPath = "/kiri/" + path.join("/");
  const upstreamUrl = new URL(upstreamPath + (req.nextUrl.search || ""), "https://grid.space");

  // Forward a subset of request headers to appear as a normal browser request.
  const forwardHeaders = new Headers();
  for (const name of ["accept", "accept-encoding", "accept-language", "user-agent", "referer"]) {
    const v = req.headers.get(name);
    if (v) forwardHeaders.set(name, v);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      headers: forwardHeaders,
      redirect: "follow",
    });
  } catch {
    return new NextResponse("Kiri upstream unreachable", { status: 502 });
  }

  // Build response headers — copy allowed upstream headers, strip the rest.
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });

  const contentType = (responseHeaders.get("content-type") ?? "").toLowerCase();
  const isHtml = contentType.includes("text/html");

  if (isHtml) {
    // Read body as text so we can inject the polyfill.
    const html = await upstream.text();

    // Inject base + polyfill as the very first things in <head>.
    // BASE_TAG keeps relative URLs (index.css, manifest.json) correct when the
    // browser is at /kiri (no trailing slash).  SAB_POLYFILL must run before
    // any deferred or module scripts (including /lib/main/kiri.js).
    const patched = html.replace(/<head([^>]*)>/i, (m) => m + BASE_TAG + SAB_POLYFILL);

    responseHeaders.set("content-type", "text/html; charset=utf-8");
    // Remove content-length since we modified the body.
    responseHeaders.delete("content-length");

    return new NextResponse(patched, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Binary / text pass-through.
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
