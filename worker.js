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
 * 3. Provides clean 404 fallback using Astro's compiled 404 page.
 *
 * All Cobalt API calls happen client-side in the browser (Hero.astro /
 * PlatformHero.astro). Downloads go directly from browser to CDN.
 * The Worker never touches video data or calls external APIs.
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

    // ── Note: /api/extract is now handled by the Node.js backend.


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
