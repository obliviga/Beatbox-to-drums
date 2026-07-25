/**
 * OPTIONAL local dev config — NOT part of the deployed app.
 *
 * Copy this file to js/local-config.js (which is .gitignored) and fill in
 * your values. The app pre-fills the ✨ AI settings from it, so you don't
 * have to type the relay URL into every fresh browser while developing.
 * Settings saved in the app's ⚙ panel always override these defaults.
 *
 * NEVER commit js/local-config.js — anything in it (your relay URL, or an
 * API key) would let strangers generate tracks on your Stability credits.
 * The public deployment ships without this file, so downloads of the repo
 * are unusable against your relay unless someone supplies their own setup.
 */
export const LOCAL_CONFIG = {
  relayUrl: 'https://beatbox-relay.YOUR-SUBDOMAIN.workers.dev',
  // apiKey: 'sk-…',   // only if you don't keep the key as a worker secret
  // prompt: 'punchy studio drum break, acoustic kit…', // custom default style
};
