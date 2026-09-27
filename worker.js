/**
 * worker.js
 *
 * Cloudflare Worker — Static Asset Server & SEO Handler
 *
 * This Worker is intentionally minimal to stay well within Cloudflare's
 * free tier limits (100K requests/day, 0 subrequests needed).
 *
 * 1. Serves static pages/assets from Cloudflare's global edge network.
 * 2. Handles /watch for bot/SEO OG meta tags (zero subrequests).
 * 3. Proxies Cobalt (POST /api/cobalt, GET /api/download) so the browser
 *    only talks to this site: server-side instance failover + per-request
 *    fresh tunnel streaming (tunnel URLs are single-use / short-lived).
 *
 * Cobalt API calls and downloads run through the same-origin proxy above
 * (Hero.astro / PlatformHero.astro). The browser never calls Cobalt
 * instances directly.
 */

// ── Security Response Headers ──────────────────────────────
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function generateNonce() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Injects security headers into any Response.
 * Generates and applies a nonce-based CSP for HTML responses.
 */
function withSecurityHeaders(response) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }

  const contentType = newHeaders.get('Content-Type') || '';
  if (!contentType.includes('text/html')) {
    const baseCsp = [
      "default-src 'self'",
      "frame-ancestors 'self'",
      "upgrade-insecure-requests"
    ].join('; ');
    newHeaders.set('Content-Security-Policy', baseCsp);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }

  const nonce = generateNonce();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'nonce-${nonce}' 'strict-dynamic' https://www.googletagmanager.com https://www.google-analytics.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://img.youtube.com https://*.ytimg.com https://*.ggpht.com https://*.cdninstagram.com https://www.google-analytics.com https://www.googletagmanager.com https://*.google.com https://*.google.co.in https://*.doubleclick.net https://analytics.google.com",
    // connect-src allows Cobalt community instances (called from browser JS)
    `connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com https://analytics.google.com https://stats.g.doubleclick.net https://cloudflareinsights.com https://melon.clxxped.lol https://apicobalt.mgytr.top https://cobalt.omega.wolfy.love https://grapefruit.clxxped.lol https://lime.clxxped.lol https://cobalt.alpha.wolfy.love https://kitty.tame.gg https://api.cobalt.liubquanti.click https://api.qwkuns.me https://*.cobalt.tools https://*.googlevideo.com https://*.cdninstagram.com https://*.fbcdn.net https://*.tiktokcdn.com https://*.twimg.com https://*.sndcdn.com https://*.redd.it https://*.redditmedia.com https://*.akamaized.net https://*.vimeocdn.com https://*.cloudfront.net https://*.pinimg.com`,
    "worker-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');

  newHeaders.set('Content-Security-Policy', csp);

  const rewrittenResponse = new HTMLRewriter()
    .on('script', {
      element(element) {
        element.setAttribute('nonce', nonce);
      }
    })
    .on('style', {
      element(element) {
        element.setAttribute('nonce', nonce);
      }
    })
    .transform(new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    }));

  return rewrittenResponse;
}

// ── Bot detection for SEO handler ──────────────────────────
const BOT_USER_AGENT_REGEX = /\b(Twitterbot|facebookexternalhit|Facebook(Catalog|Bot)|Discordbot|WhatsApp|TelegramBot|Slackbot(-LinkExpanding)?|Slack-ImgProxy|LinkedInBot|Pinterest(bot)?|Mastodon|Threads|SnapchatBot|Line(-NewsDigest)?|Googlebot|Google-InspectionTool|Google-Extended|bingbot|msnbot|YahooSeeker|DuckDuckBot|Baiduspider|YandexBot|Sogou(Spider)?|Exabot|AhrefsBot|SemrushBot|MJ12bot|DotBot|GPTBot|Claude-Web|anthropic-ai|PerplexityBot|CCBot|cohere-ai|Embedly|Iframely|unfurl|Rogerbot|UptimeRobot|Pingdom(Bot)?|StatusCake|HeadlessChrome|PhantomJS|Prerender|facebot|ia_archiver|scrapy|python-requests|wget|curl)\b/i;

function getYoutubeVideoId(url) {
  try {
    const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function escapeHtml(val) {
  if (!val) return "";
  return val.toString()
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Build OG meta HTML for bots (Discord, Twitter, Facebook, etc.)
 * No subrequests — uses only YouTube thumbnail URL pattern or defaults.
 */
function buildOgHtml(title, thumbnail, description, videoUrl, siteUrl) {
  const safeTitle = escapeHtml(title || 'Video on mp4yt');
  const safeDesc = escapeHtml(description || `Watch and download "${title}" via mp4yt`);
  const safeThumbnail = escapeHtml(thumbnail || `${siteUrl}/og-default.png`);
  const safeOgUrl = escapeHtml(siteUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — mp4yt</title>
  <meta name="description" content="${safeDesc}" />
  <meta property="og:type" content="video.other" />
  <meta property="og:site_name" content="mp4yt" />
  <meta property="og:url" content="${safeOgUrl}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeThumbnail}" />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height" content="720" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@mp4yt" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeThumbnail}" />
  <meta name="robots" content="noindex, follow" />
</head>
<body style="font-family:system-ui,sans-serif;background:#fafafa;color:#171717;padding:40px;max-width:640px;margin:auto">
  <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.5px;margin-bottom:12px">${safeTitle}</h1>
  ${safeThumbnail ? `<img src="${safeThumbnail}" alt="Thumbnail" style="width:100%;border-radius:8px;margin-bottom:16px" />` : ''}
  <p style="color:#4d4d4d;margin-bottom:24px">${safeDesc}</p>
  <a href="${siteUrl}/#url=${encodeURIComponent(videoUrl || '')}"
     style="display:inline-flex;align-items:center;gap:8px;background:#171717;color:#fff;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:14px;font-weight:500">
    ↓ Download on mp4yt
  </a>
</body>
</html>`;
}

// ── Cobalt same-origin proxy ──────────────────────────────────
// The browser only talks to this Worker. Instance failover and the byte
// download happen server-side (edge -> instance), which fixes:
//  - Cobalt instances unreachable/blocked from the user's network
//  - Single-use, short-lived tunnel URLs breaking download managers:
//    /api/download re-resolves a FRESH tunnel on EVERY request, so the
//    link is stable and retry / multi-thread safe.
const COBALT_INSTANCES = [
  "https://cobalt-awhs.onrender.com",
  "https://cobaltapi.cjs.nz",
  "https://rue-cobalt.xenon.zone",
];
const COBALT_INSTANCE_TIMEOUT_MS = 20000;

// Hosts /api/download is allowed to fetch: the Cobalt instances plus the
// media CDNs that Cobalt "redirect" responses point to. Anything else -> 403.
const PROXIABLE_HOST_SUFFIXES = [
  "cobalt-awhs.onrender.com",
  "cobaltapi.cjs.nz",
  "rue-cobalt.xenon.zone",
  "googlevideo.com",
  "cdninstagram.com",
  "fbcdn.net",
  "tiktokcdn.com",
  "twimg.com",
  "sndcdn.com",
  "redd.it",
  "redditmedia.com",
  "akamaized.net",
  "vimeocdn.com",
  "cloudfront.net",
  "pinimg.com",
];

function isProxiableUrl(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== "https:") return false;
    return PROXIABLE_HOST_SUFFIXES.some(
      (s) => u.hostname === s || u.hostname.endsWith("." + s),
    );
  } catch {
    return false;
  }
}

// Cobalt error codes where trying the next instance may help.
const COBALT_RETRY_CODES = new Set([
  "error.api.auth.jwt.missing",
  "error.api.auth.jwt.invalid",
  "error.api.auth.turnstile.missing",
  "error.api.auth.turnstile.invalid",
  "error.api.auth.key.invalid",
  "error.api.auth.key.ip_not_allowed",
  "error.api.youtube.login",
  "error.api.youtube.decipher",
]);

// Best-effort in-memory per-IP rate limit for /api/*.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_HITS = 120;
const rateHits = new Map();
function hitRateLimit(ip) {
  const now = Date.now();
  const arr = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateHits.set(ip, arr);
  if (rateHits.size > 5000) rateHits.clear();
  return arr.length > RATE_MAX_HITS;
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** POST body to each Cobalt instance in order; return first usable JSON. */
async function cobaltResolve(body) {
  let lastError = null;
  for (const instance of COBALT_INSTANCES) {
    try {
      const res = await fetchWithTimeout(
        instance,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
        COBALT_INSTANCE_TIMEOUT_MS,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data !== "object") {
        lastError = new Error(`instance ${instance}: HTTP ${res.status}`);
        continue;
      }
      if (
        data.status === "tunnel" ||
        data.status === "redirect" ||
        data.status === "picker"
      ) {
        return data;
      }
      if (data.status === "error") {
        const code = data.error && data.error.code;
        if (COBALT_RETRY_CODES.has(code)) {
          lastError = new Error(`instance ${instance}: ${code}`);
          continue; // try next instance
        }
        return data; // permanent error for this video — fail fast
      }
      lastError = new Error(`instance ${instance}: unexpected response`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("all Cobalt instances failed");
}

function jsonResponse(data, status = 200) {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }),
  );
}

/** Build the Cobalt POST body from /api/download query params. */
function cobaltBodyFromParams(params) {
  const videoUrl = (params.get("url") || "").trim();
  const quality = params.get("quality") || "720";
  const mode = params.get("mode") || "auto";
  if (!validateUrl(videoUrl)) return null;
  const body = {
    url: videoUrl,
    downloadMode: mode,
    youtubeVideoCodec: "h264",
  };
  if (mode === "audio") {
    body.audioFormat = quality === "best" ? "mp3" : quality;
  } else {
    body.videoQuality = quality === "best" ? "max" : quality;
  }
  return body;
}

/** Resolve a fresh stream URL for the given params (throws on failure). */
async function resolveStreamUrl(params) {
  const body = cobaltBodyFromParams(params);
  if (!body) {
    const err = new Error("invalid url");
    err.statusCode = 400;
    throw err;
  }
  const data = await cobaltResolve(body);
  let streamUrl = "";
  if (
    (data.status === "tunnel" || data.status === "redirect") &&
    typeof data.url === "string"
  ) {
    streamUrl = data.url;
  } else if (
    data.status === "picker" &&
    Array.isArray(data.picker) &&
    data.picker.length > 0 &&
    typeof data.picker[0].url === "string"
  ) {
    streamUrl = data.picker[0].url;
  }
  if (!streamUrl || !isProxiableUrl(streamUrl)) {
    const err = new Error(
      (data && data.error && data.error.code) || "no stream url",
    );
    err.statusCode = 502;
    err.cobaltData = data;
    throw err;
  }
  return streamUrl;
}

/** POST /api/cobalt — proxied Cobalt API with server-side failover. */
async function handleApiCobalt(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (hitRateLimit(ip)) {
    return jsonResponse(
      { status: "error", error: { code: "error.api.rate_exceeded" } },
      429,
    );
  }
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || !validateUrl(body.url)) {
    return jsonResponse(
      { status: "error", error: { code: "error.api.link.unsupported" } },
      400,
    );
  }
  try {
    const data = await cobaltResolve(body);
    return jsonResponse(data, 200);
  } catch (e) {
    return jsonResponse(
      { status: "error", error: { code: "error.api.fetch.fail" } },
      200,
    );
  }
}

/**
 * GET /api/download — resolve a FRESH tunnel every request, then stream it.
 * Stable link: download managers can retry / multi-thread safely because
 * each request consumes its own single-use tunnel server-side.
 * ?url= &quality= &mode= &filename= &inline=1
 */
async function handleApiDownload(request, url) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (hitRateLimit(ip)) {
    return withSecurityHeaders(
      new Response("Rate limited, try again later.", { status: 429 }),
    );
  }

  let streamUrl;
  try {
    streamUrl = await resolveStreamUrl(url.searchParams);
  } catch (e) {
    const code =
      (e && e.cobaltData && e.cobaltData.error && e.cobaltData.error.code) ||
      "error.api.fetch.fail";
    return jsonResponse(
      { status: "error", error: { code } },
      e && e.statusCode ? e.statusCode : 502,
    );
  }

  const fwdHeaders = {};
  const range = request.headers.get("range");
  if (range) fwdHeaders["range"] = range;

  let upstream;
  try {
    upstream = await fetch(streamUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: fwdHeaders,
    });
  } catch (e) {
    return withSecurityHeaders(
      new Response("Upstream fetch failed.", { status: 502 }),
    );
  }
  if (!upstream.ok && upstream.status !== 206) {
    return withSecurityHeaders(
      new Response("Upstream error.", { status: 502 }),
    );
  }

  const outHeaders = new Headers();
  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  if (!outHeaders.has("content-type"))
    outHeaders.set("content-type", "video/mp4");

  const inline = url.searchParams.get("inline") === "1";
  const upstreamCD = upstream.headers.get("content-disposition");
  if (upstreamCD && !inline) {
    outHeaders.set("content-disposition", upstreamCD);
  } else {
    const filename =
      (url.searchParams.get("filename") || "").trim() || "video.mp4";
    const safe = encodeURIComponent(filename).replace(/'/g, "%27");
    outHeaders.set(
      "content-disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${safe}`,
    );
  }

  // Stream straight through — the Worker never buffers the file.
  return withSecurityHeaders(
    new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    }),
  );
}

// ── Main fetch handler ──────────────────────────────────────
// Note: Cobalt API + downloads go through the same-origin proxy above
// (POST /api/cobalt, GET /api/download); the browser never calls Cobalt
// instances directly. The Worker also serves static assets and /watch SEO.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 0. Cobalt proxy API (same-origin; see above)
    if (pathname === "/api/cobalt" && request.method === "POST") {
      return handleApiCobalt(request);
    }
    if (
      pathname === "/api/download" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return handleApiDownload(request, url);
    }

    // 1. /watch — SEO handler (zero subrequests)
    //    Bots get OG tags with YouTube thumbnail. Humans get redirected to homepage.
    if (pathname === '/watch') {
      const ua = request.headers.get('user-agent') || "";
      const isBot = BOT_USER_AGENT_REGEX.test(ua);

      const protocol = url.protocol;
      const host = url.host;
      const siteUrl = `${protocol}//${host}`;
      const queryUrl = (url.searchParams.get('url') || '').trim();

      if (!queryUrl || !validateUrl(queryUrl)) {
        if (isBot) {
          const html = buildOgHtml('mp4yt — Download Any Video Instantly', `${siteUrl}/og-default.png`, 'Download videos from YouTube, TikTok, Instagram and 1000+ platforms instantly.', '', siteUrl);
          return withSecurityHeaders(new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=300' } }));
        } else {
          return Response.redirect(`${siteUrl}/`, 302);
        }
      }

      if (!isBot) {
        const redirectUrl = `${siteUrl}/#url=${encodeURIComponent(queryUrl)}`;
        return new Response(null, {
          status: 302,
          headers: {
            'Location': redirectUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
          }
        });
      }

      // Bot path: build OG tags using YouTube thumbnail pattern (zero subrequests)
      let title = 'Video';
      let thumbnail = `${siteUrl}/og-default.png`;
      const description = `Watch and download this video via mp4yt`;

      const ytId = getYoutubeVideoId(queryUrl);
      if (ytId) {
        title = `YouTube Video ${ytId}`;
        thumbnail = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
      }

      const html = buildOgHtml(title, thumbnail, description, queryUrl, siteUrl);
      return withSecurityHeaders(new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'public, max-age=300, s-maxage=300'
        }
      }));
    }

    // 2. Serve static files from Cloudflare's Assets storage
    try {
      const response = await env.ASSETS.fetch(request);

      if (response.status === 404) {
        const notFoundRequest = new Request(new URL('/404.html', request.url));
        const notFoundResponse = await env.ASSETS.fetch(notFoundRequest);
        if (notFoundResponse.status === 200) {
          return withSecurityHeaders(new Response(notFoundResponse.body, {
            status: 404,
            headers: notFoundResponse.headers,
          }));
        }
      }

      return withSecurityHeaders(response);
    } catch (err) {
      console.error(`[Worker] Error fetching asset:`, err.message);
      return withSecurityHeaders(new Response('Something went wrong. Please try again.', { status: 500 }));
    };

  }
};
