/**
 * Reverse-proxy for Kiri:Moto's /lib/ assets (JS workers, libraries).
 *
 * Web Workers have their own global scope — they don't inherit the
 * SharedArrayBuffer polyfill injected into the Kiri HTML page.  This route
 * prepends the polyfill to every JavaScript file so workers also see
 * `self.SharedArrayBuffer` as truthy, preventing the
 * "ReferenceError: SharedArrayBuffer is not defined" thrown during slicing.
 */

import { type NextRequest, NextResponse } from "next/server";

// Prepend this to every JS file so it runs before any worker code.
// `self` is the global in both browser windows (self === window) and workers.
const JS_POLYFILL =
  'if(typeof SharedArrayBuffer==="undefined"){self.SharedArrayBuffer=self.ArrayBuffer;}\n';
const JS_POLYFILL_BYTES = new TextEncoder().encode(JS_POLYFILL);

const STRIP_RESPONSE_HEADERS = new Set([
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "content-encoding",
  "transfer-encoding",
]);

export const dynamic = "force-dynamic";

async function handler(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;

  const upstreamUrl = new URL(
    "/lib/" + path.join("/") + (req.nextUrl.search || ""),
    "https://grid.space",
  );

  const forwardHeaders = new Headers();
  for (const name of ["accept", "accept-encoding", "accept-language", "user-agent"]) {
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
    return new NextResponse("Kiri /lib/ upstream unreachable", { status: 502 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });

  const contentType = (responseHeaders.get("content-type") ?? "").toLowerCase();
  const isJs = contentType.includes("javascript") || upstreamUrl.pathname.endsWith(".js");

  if (isJs && upstream.body) {
    // Stream: prepend polyfill bytes, then pipe the upstream body.
    // No full-file buffering needed — we just push a small chunk first.
    const upstreamBody = upstream.body;
    const prefixed = new ReadableStream({
      async start(controller) {
        controller.enqueue(JS_POLYFILL_BYTES);
        const reader = upstreamBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          controller.close();
        }
      },
    });

    responseHeaders.delete("content-length");
    return new NextResponse(prefixed, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const HEAD = handler;
