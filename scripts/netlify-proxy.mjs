/**
 * Writes client/dist/_redirects for Netlify from the API_ORIGIN environment
 * variable (see netlify.toml). Run after `vite build`, from client/.
 *
 * Every path the API serves is proxied (status 200, forced), and anything
 * else falls back to index.html so React Router can handle deep links.
 */

import fs from 'node:fs';
import path from 'node:path';

const origin = String(process.env.API_ORIGIN ?? '').trim().replace(/\/+$/, '');

if (!/^https:\/\/[^/\s]+$/.test(origin)) {
  console.error(
    '[netlify-proxy] Set API_ORIGIN in Netlify to your Render address, e.g. https://growvanta-api.onrender.com'
  );
  process.exit(1);
}

const rules = [
  `/api/*           ${origin}/api/:splat        200!`,
  `/webhooks/*      ${origin}/webhooks/:splat   200!`,
  `/f/*             ${origin}/f/:splat          200!`,
  `/embed/*         ${origin}/embed/:splat      200!`,
  `/public-form.js  ${origin}/public-form.js    200!`,
  '/*               /index.html                 200',
];

const target = path.resolve('dist', '_redirects');
fs.writeFileSync(target, `${rules.join('\n')}\n`);
console.log(`[netlify-proxy] wrote ${target} -> ${origin}`);
