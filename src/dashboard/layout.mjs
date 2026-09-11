import { BASE } from './base.mjs';
import { CLIENT } from '../config.mjs';
// Server-rendered HTML shell. No framework, no CDN, no build step, no fonts to
// download. Mobile-first because the owner reads this on a phone.

export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const COLOURS = {
  ink: '#08382b',
  green: '#087548',
  paper: '#f8fbf9',
  lime: '#9be36d',
};

const CSS = `
:root{
  --ink:${COLOURS.ink};
  --green:${COLOURS.green};
  --paper:${COLOURS.paper};
  --lime:${COLOURS.lime};
  --line:#d5e3dc;
  --muted:#4d6b60;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--paper);
  color:var(--ink);
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
a{color:var(--green)}
header.top{background:var(--ink);color:var(--paper);padding:12px 16px}
header.top .title{font-size:17px;font-weight:600;letter-spacing:.01em}
header.top .sub{font-size:14px;color:#bcd6ca;margin-top:2px}
nav.tabs{display:flex;flex-wrap:wrap;gap:0;background:var(--ink);border-top:1px solid #14513e}
nav.tabs a{
  flex:1 1 auto;min-width:20%;min-height:46px;display:flex;align-items:center;justify-content:center;
  color:#cfe6da;text-decoration:none;font-size:15px;padding:0 10px;border-bottom:3px solid transparent;
}
nav.tabs a.on{color:#fff;border-bottom-color:var(--lime);font-weight:600}
main{padding:12px 12px 48px;max-width:900px;margin:0 auto}
section{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 12px}
h2{font-size:16px;margin:0 0 8px;font-weight:600}
h3{font-size:15px;margin:14px 0 6px;font-weight:600}
p{margin:0 0 8px}
.muted{color:var(--muted);font-size:14px}
pre.plain{
  white-space:pre-wrap;word-break:break-word;margin:0;
  font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.tiles{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px}
.tile{flex:1 1 84px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--paper)}
.tile .n{font-size:22px;font-weight:600;line-height:1.1}
.tile .k{font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:13px;color:var(--muted);font-weight:600;text-transform:none}
td.num,th.num{text-align:right;white-space:nowrap}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.lead{border-bottom:1px solid var(--line);padding:12px 0}
.lead:last-child{border-bottom:0}
.lead .nm{font-size:17px;font-weight:600}
.lead .meta{font-size:14px;color:var(--muted);margin-top:2px}
.lead .why{font-size:14px;margin-top:4px}
.lead .contact{margin-top:6px;font-size:15px}
.lead .contact a{display:inline-block;min-height:34px;line-height:34px;margin-right:14px}
.pill{
  display:inline-block;font-size:13px;padding:2px 8px;border-radius:99px;
  border:1px solid var(--line);background:var(--paper);color:var(--muted);
}
.pill.on{background:var(--lime);border-color:var(--lime);color:var(--ink);font-weight:600}
form.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
form.filters label{display:flex;flex-direction:column;font-size:13px;color:var(--muted);flex:1 1 140px}
select,input[type=text],input[type=search]{
  font:16px/1.2 inherit;min-height:44px;padding:8px;margin-top:3px;
  border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);width:100%;
}
button{
  font:15px/1 inherit;min-height:44px;padding:10px 12px;border-radius:6px;
  border:1px solid var(--green);background:var(--green);color:#fff;cursor:pointer;
}
button.ghost{background:#fff;color:var(--ink);border-color:var(--line)}
button.ghost:hover{border-color:var(--green)}
form.status{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
form.status input[type=text]{flex:1 1 100%;min-width:0}
form.status button{flex:1 1 auto;min-width:78px}
.note{white-space:pre-wrap;font-size:14px;color:var(--muted);margin-top:6px}
.model{margin-top:8px;padding-left:10px;border-left:2px solid var(--line)}
.model .evidence{margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--muted)}
.model .evidence li{margin:2px 0}
.model pre.plain{margin-top:6px;font-size:13px}
.flash{background:var(--lime);border:1px solid var(--lime);border-radius:6px;padding:10px 12px;margin:0 0 12px;font-size:15px}
.flash.bad{background:#ffe3e0;border-color:#f3b7b0}
.spark{display:block}
.blocked{color:#8a2b20}
footer.foot{padding:0 12px 32px;max-width:900px;margin:0 auto;font-size:13px;color:var(--muted)}
@media (min-width:640px){
  main{padding:16px 16px 56px}
  nav.tabs a{min-width:0}
}
`;

const TABS = [
  ['/', 'Today'],
  ['/leads', 'Register'],
  ['/prices', 'Prices'],
  ['/runs', 'Runs'],
  ['/report/weekly', 'Weekly'],
];

/**
 * Wrap a page body. `active` is the tab path. `chrome: false` renders a bare
 * document (used for the standalone weekly report file, which has no tabs).
 */
export function page({ title, subtitle = '', active = null, body, chrome = true }) {
  const tabs = chrome
    ? `<nav class="tabs">${TABS.map(
        ([href, name]) =>
          `<a href="${BASE}${esc(href)}"${href === active ? ' class="on"' : ''}>${esc(name)}</a>`
      ).join('')}</nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="title">${esc(CLIENT.digest.title)}</div>
  ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
</header>
${tabs}
<main>
${body}
</main>
<footer class="foot">Business listing data only. Map listings: data (c) OpenStreetMap contributors, ODbL 1.0. Mandi prices: data.gov.in. Nothing on this page sends a message to anyone.</footer>
</body>
</html>
`;
}

/** Small inline SVG sparkline. Returns null when there is nothing to draw. */
export function sparkline(values, { width = 120, height = 26, stroke = COLOURS.green } = {}) {
  const points = values.map((v, i) => [i, v]).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (points.length < 2) return null;
  const ys = points.map(([, v]) => v);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const stepX = values.length > 1 ? (width - 2) / (values.length - 1) : 0;
  const d = points
    .map(([i, v], k) => {
      const x = (1 + i * stepX).toFixed(1);
      const y = (height - 2 - ((v - min) / span) * (height - 4)).toFixed(1);
      return `${k === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
  const last = points[points.length - 1];
  const lx = (1 + last[0] * stepX).toFixed(1);
  const ly = (height - 2 - ((last[1] - min) / span) * (height - 4)).toFixed(1);
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    `${points.length} readings, low ${min}, high ${max}`
  )}"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"/><circle cx="${lx}" cy="${ly}" r="2.2" fill="${stroke}"/></svg>`;
}
