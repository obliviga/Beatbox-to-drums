/**
 * Beatbox → Drums: AI-restyle relay (Cloudflare Worker).
 *
 * Browsers can't call api.stability.ai directly (no CORS), so the app
 * sends its generation requests here and this worker forwards them.
 *
 * Deploy (free tier is plenty):
 *   1. dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Paste this file, Deploy, copy the *.workers.dev URL into the app
 *   3. Either store your Stability key as a Worker secret named
 *      STABILITY_API_KEY (Settings → Variables — recommended), or paste
 *      the key into the app instead and it will be forwarded per-request.
 *
 * The worker only forwards POSTs to the one Stability endpoint the app
 * uses — it is not a general-purpose proxy.
 */

const UPSTREAM = 'https://api.stability.ai';
const ALLOWED_PATHS = new Set(['/v2beta/audio/stable-audio-2/audio-to-audio']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-api-key, accept',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    if (request.method !== 'POST' || !ALLOWED_PATHS.has(url.pathname)) {
      return new Response('Not found', { status: 404, headers: CORS });
    }

    const key = env.STABILITY_API_KEY || request.headers.get('x-api-key');
    if (!key) {
      return new Response(
        'No API key: set the STABILITY_API_KEY worker secret, or paste your key into the app.',
        { status: 401, headers: CORS },
      );
    }

    const upstream = await fetch(UPSTREAM + url.pathname, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: request.headers.get('accept') || 'audio/*',
        'Content-Type': request.headers.get('content-type') || '',
      },
      body: request.body,
    });

    const headers = new Headers(CORS);
    headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
