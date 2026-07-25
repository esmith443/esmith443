#!/usr/bin/env node
/**
 * Renders assets/stats.svg: one card, generated from the GitHub API in the
 * EmmaTech palette.
 *
 * This exists because every free stats-card service (github-readme-stats,
 * github-profile-summary-cards) shares an upstream API quota and periodically
 * serves a red "rate limited" image to visitors. Generating the card here means
 * the profile renders a static file that cannot rate-limit, and if a run fails
 * the previous good card simply stays in place.
 *
 * Auth: uses GITHUB_TOKEN when present (GitHub Actions). Otherwise it shells out
 * to `gh api graphql`, so a local run borrows the gh CLI's own credentials and
 * no token is ever read or written by this script.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN = process.env.PROFILE_LOGIN || 'esmith443';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'assets/stats.svg');

// EmmaTech tokens
const C = {
  surface: '#0e0d15',
  surfaceHi: '#14121c',
  edge: 'rgba(255,255,255,0.10)',
  border: 'rgba(255,255,255,0.08)',
  text: '#edecf2',
  text2: '#9a96a8',
  text3: '#6e6a7c',
  accent: '#8d7bf2',
  accentBright: '#a897ff',
  accentDeep: '#6a55d9'
};

const QUERY = `
query($login: String!) {
  user(login: $login) {
    createdAt
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function graphql() {
  const token = process.env.GITHUB_TOKEN;
  const body = JSON.stringify({ query: QUERY, variables: { login: LOGIN } });

  if (token) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'profile-stats-builder'
      },
      body
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }

  // Local run: let the gh CLI supply auth.
  const out = execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: body,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  const json = JSON.parse(out);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.count > 0) { run += 1; longest = Math.max(longest, run); }
    else run = 0;
  }
  // Current streak counts back from the most recent day. Today not yet having a
  // contribution does not break it; an empty yesterday does.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) current += 1;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { current, longest };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nf = (n) => n.toLocaleString('en-US');

/**
 * Weekly bars rather than an area curve. Contribution history is sparse and
 * spiky; a smoothed curve over it is a flat line with one bump, which reads as
 * a broken chart rather than as real data.
 */
function bars(values, x, y, w, h) {
  const max = Math.max(1, ...values);
  const slot = w / values.length;
  const bw = Math.max(2.5, slot - 3);
  return values.map((v, i) => {
    const bh = v === 0 ? 1.5 : Math.max(3, (v / max) * h);
    const bx = x + i * slot + (slot - bw) / 2;
    const by = y + h - bh;
    const fill = v === 0 ? 'url(#barEmpty)' : 'url(#barFill)';
    return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(2, bw / 2).toFixed(1)}" fill="${fill}"/>`;
  }).join('');
}

function render(d) {
  const cal = d.user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) =>
    w.contributionDays.map((x) => ({ date: x.date, count: x.contributionCount }))
  );
  const { current, longest } = streaks(days);

  const repos = d.user.repositories;
  const stars = repos.nodes.reduce((a, r) => a + r.stargazerCount, 0);

  // Weekly totals drive the chart; daily is too noisy at this width.
  const weekly = cal.weeks.map((w) =>
    w.contributionDays.reduce((a, x) => a + x.contributionCount, 0)
  );

  const byLang = new Map();
  for (const r of repos.nodes) {
    for (const e of r.languages.edges) {
      byLang.set(e.node.name, (byLang.get(e.node.name) || 0) + e.size);
    }
  }
  const totalBytes = [...byLang.values()].reduce((a, b) => a + b, 0) || 1;
  const langs = [...byLang.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, size]) => ({ name, pct: (size / totalBytes) * 100 }));

  // Violet ramp rather than GitHub's language colours: the site runs on a single
  // accent, and a rainbow bar would break that.
  const ramp = ['#a897ff', '#8d7bf2', '#6a55d9', '#4c3ea0', '#332a68'];

  const W = 1000, H = 330;
  const stats = [
    [nf(cal.totalContributions), 'contributions'],
    [nf(repos.totalCount), 'public repos'],
    [nf(current), current === 1 ? 'day streak' : 'day streak'],
    [nf(longest), 'longest streak']
  ];

  const cells = stats.map((s, i) => {
    const cx = 32 + (i % 2) * 158;
    const cy = 116 + Math.floor(i / 2) * 78;
    return `
    <text x="${cx}" y="${cy}" fill="${C.text}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="30" font-weight="600" letter-spacing="-0.8">${s[0]}</text>
    <text x="${cx}" y="${cy + 21}" fill="${C.text2}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="12.5" letter-spacing="0.2">${s[1]}</text>`;
  }).join('');

  const chart = bars(weekly, 372, 100, 596, 112);

  let barX = 32;
  const bar = langs.map((l, i) => {
    const w = (l.pct / 100) * 936;
    const seg = `<rect x="${barX.toFixed(1)}" y="262" width="${Math.max(0, w - 2).toFixed(1)}" height="9" rx="4.5" fill="${ramp[i]}"/>`;
    barX += w;
    return seg;
  }).join('');

  let legX = 32;
  const legend = langs.map((l, i) => {
    const label = `${l.name} ${l.pct.toFixed(1)}%`;
    const seg = `
    <circle cx="${legX + 4}" cy="${296}" r="4" fill="${ramp[i]}"/>
    <text x="${legX + 15}" y="${300}" fill="${C.text2}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="12.5">${esc(label)}</text>`;
    legX += 26 + label.length * 6.9;
    return seg;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="GitHub statistics for ${esc(LOGIN)}">
  <title>${esc(LOGIN)} — ${nf(cal.totalContributions)} contributions in the last year</title>
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.surfaceHi}"/>
      <stop offset="100%" stop-color="${C.surface}"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>
    <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.accentBright}"/>
      <stop offset="100%" stop-color="${C.accentDeep}" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="barEmpty" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.09"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.09"/>
    </linearGradient>
    <linearGradient id="hair" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${C.accent}" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="${C.accent}" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="cardGlow" gradientUnits="userSpaceOnUse" cx="500" cy="0" r="520">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0.13"/>
      <stop offset="70%" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="14"/></clipPath>
  </defs>

  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="url(#cardBg)"/>
    <rect width="${W}" height="${H}" fill="url(#cardGlow)"/>
    <rect width="${W}" height="1" fill="url(#edge)"/>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${C.border}"/>

  <text x="32" y="46" fill="${C.accentBright}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="19" font-weight="600" letter-spacing="-0.3">${esc(LOGIN)}</text>
  <text x="${W - 32}" y="46" text-anchor="end" fill="${C.text3}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="12.5">last 12 months${stars > 0 ? ` · ${nf(stars)} stars` : ''}</text>
  <rect x="32" y="64" width="${W - 64}" height="1" fill="url(#hair)"/>
${cells}

${chart}
  <rect x="372" y="213" width="596" height="1" fill="#ffffff" opacity="0.07"/>
  <text x="372" y="232" fill="${C.text3}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="11.5">weekly contributions</text>
  <text x="968" y="232" text-anchor="end" fill="${C.text3}" font-family="Geist,'Segoe UI',system-ui,sans-serif" font-size="11.5">52 weeks</text>

${bar}
${legend}
</svg>
`;
}

try {
  const data = await graphql();
  if (!data?.user) throw new Error('no user in response');
  const svg = render(data);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, svg, 'utf8');
  console.log(`wrote ${OUT} (${svg.length} bytes)`);
} catch (err) {
  // Leave the previous card in place rather than publishing a broken one.
  console.error(`stats build failed: ${err.message}`);
  if (existsSync(OUT)) {
    console.error('keeping the existing assets/stats.svg');
    process.exit(0);
  }
  process.exit(1);
}
