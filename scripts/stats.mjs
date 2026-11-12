// Renders the profile's stat cards from the account's own data, private repos included.
// Privacy: the cards carry only aggregate numbers and language percentages — never a repo,
// org or file name — and nothing is logged, because Actions logs on this repo are public.
import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.STATS_TOKEN || process.env.GH_TOKEN;
if (!token) throw new Error("Set STATS_TOKEN (or GH_TOKEN)");

const HIDDEN_LANGS = new Set(["HTML", "CSS", "TeX", "Jupyter Notebook"]);
const LANG_COUNT = 8;
const theme = { bg: "#1a1b27", title: "#70a5fd", text: "#38bdae", icon: "#bf91f3", track: "#2a2e42" };
const font = "'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif";

const icons = {
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z",
  commit: "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  issue: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
};

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "profile-stats", ...init.headers },
  });
  const json = await res.json().catch(() => ({}));
  // Only the status is reported: response bodies can name private repos or orgs.
  if (!res.ok || json.errors) throw new Error(`GitHub API request failed (HTTP ${res.status})`);
  return json;
}

const gql = async (query, variables) =>
  (await api("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query, variables }) })).data;

async function collect() {
  const { viewer } = await gql(`{
    viewer {
      login name
      pullRequests { totalCount }
      issues { totalCount }
      contributionsCollection {
        totalRepositoriesWithContributedCommits
        contributionCalendar { totalContributions }
      }
    }
  }`);

  let stars = 0;
  let privateRepos = 0;
  const langs = new Map();
  for (let after = null; ; ) {
    const page = await gql(
      `query($after: String) {
        viewer {
          repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isPrivate
              stargazerCount
              languages(first: 20) { edges { size node { name color } } }
            }
          }
        }
      }`,
      { after },
    );
    const { nodes, pageInfo } = page.viewer.repositories;
    for (const repo of nodes) {
      stars += repo.stargazerCount;
      if (repo.isPrivate) privateRepos++;
      for (const { size, node } of repo.languages.edges) {
        if (HIDDEN_LANGS.has(node.name)) continue;
        const entry = langs.get(node.name) ?? { name: node.name, color: node.color ?? "#858585", size: 0 };
        entry.size += size;
        langs.set(node.name, entry);
      }
    }
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  // A token without private access would silently publish public-only numbers.
  if (!privateRepos) throw new Error("Token can't see private repos; use a classic token with the repo scope");

  const commits = (await api(`https://api.github.com/search/commits?q=author:${viewer.login}&per_page=1`)).total_count;

  const total = [...langs.values()].reduce((sum, l) => sum + l.size, 0);
  const topLangs = [...langs.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, LANG_COUNT)
    .map((l) => ({ name: l.name, color: l.color, pct: (l.size / total) * 100 }));

  return {
    name: viewer.name || viewer.login,
    stars,
    commits,
    prs: viewer.pullRequests.totalCount,
    issues: viewer.issues.totalCount,
    contributedTo: viewer.contributionsCollection.totalRepositoriesWithContributedCommits,
    yearContributions: viewer.contributionsCollection.contributionCalendar.totalContributions,
    topLangs,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => n.toLocaleString("en-US");

function card(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
<style>
  .title { font: 600 18px ${font}; fill: ${theme.title}; }
  .label { font: 600 14px ${font}; fill: ${theme.text}; }
  .value { font: 700 14px ${font}; fill: ${theme.text}; }
  .small { font: 400 11px ${font}; fill: ${theme.text}; }
  .big { font: 800 24px ${font}; fill: ${theme.title}; }
  .row { opacity: 0; animation: fade .5s ease-in-out forwards; }
  @keyframes fade { to { opacity: 1; } }
</style>
<rect width="${width}" height="${height}" rx="16" fill="${theme.bg}"/>
${body}
</svg>
`;
}

function statsCard(s) {
  const rows = [
    ["star", "Total Stars Earned", s.stars],
    ["commit", "Total Commits", s.commits],
    ["pr", "Total PRs", s.prs],
    ["issue", "Total Issues", s.issues],
    ["repo", "Contributed to (last year)", s.contributedTo],
  ]
    .map(
      ([icon, label, value], i) => `<g class="row" transform="translate(25, ${70 + i * 25})" style="animation-delay:${150 + i * 150}ms">
  <path transform="translate(0,-12)" fill="${theme.icon}" fill-rule="evenodd" d="${icons[icon]}"/>
  <text class="label" x="25" y="0">${label}:</text>
  <text class="value" x="220" y="0">${num(value)}</text>
</g>`,
    )
    .join("\n");

  const r = 42;
  const ring = `<g transform="translate(390, 105)">
  <circle r="${r}" stroke="${theme.track}" stroke-width="6"/>
  <circle r="${r}" stroke="${theme.title}" stroke-width="6" stroke-linecap="round"/>
  <text class="big" text-anchor="middle" y="4">${num(s.yearContributions)}</text>
  <text class="small" text-anchor="middle" y="22">this year</text>
</g>`;

  return card(467, 195, `<text class="title" x="25" y="38">${esc(s.name)}'s GitHub Stats</text>\n${rows}\n${ring}`);
}

function langsCard(langs) {
  const barWidth = 250;
  let x = 0;
  const bar = langs
    .map((l) => {
      const w = Math.max((l.pct / 100) * barWidth, 2);
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join("");
  const legend = langs
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      return `<g class="row" transform="translate(${col * 130}, ${row * 25})" style="animation-delay:${150 + i * 100}ms">
  <circle cx="5" cy="6" r="5" fill="${l.color}"/>
  <text class="small" x="15" y="10">${esc(l.name)} ${l.pct.toFixed(1)}%</text>
</g>`;
    })
    .join("\n");

  return card(
    300,
    195,
    `<text class="title" x="25" y="38">Most Used Languages</text>
<clipPath id="bar"><rect x="25" y="58" width="${barWidth}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)" transform="translate(25, 58)">${bar}</g>
<g transform="translate(25, 82)">${legend}</g>`,
  );
}

const stats = await collect();
await mkdir(new URL("../assets/", import.meta.url), { recursive: true });
await writeFile(new URL("../assets/stats.svg", import.meta.url), statsCard(stats));
await writeFile(new URL("../assets/langs.svg", import.meta.url), langsCard(stats.topLangs));
