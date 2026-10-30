/**
 * The admin panel's shell: one HTML document, one stylesheet, one script.
 *
 * Everything is hand-written and served from this process, so there is no
 * build step and no frontend dependency. Client code lives in `app.js` because
 * the server sends a Content-Security-Policy that blocks inline scripts.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export type NavKey = 'tables' | 'schema' | 'settings' | null

export interface LayoutOptions {
  title: string
  /** Email of the signed-in administrator. Absent on login/setup/error pages. */
  user?: { email: string; role: string } | null
  csrf?: string
  active?: NavKey
  /** Small trail above the H1, e.g. Schema / posts. */
  breadcrumbs?: { label: string; href?: string }[]
  body: string
  /** Full-width page for data tables and forms. */
  wide?: boolean
  /** Standalone card page used by the login and setup screens. */
  bare?: boolean
}

export function pagetitle(title: string): string {
  return title === 'MungilBase' ? title : `${title} · MungilBase`
}

const ICONS: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.03z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  key: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="M10 13l9-9M16 4l3 3M14 6l3 3"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
}

export function icon(name: keyof typeof ICONS | string, size = 16): string {
  const path = ICONS[name] ?? ''
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

function navItem(href: string, label: string, iconName: string, active: boolean): string {
  return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ''}>${icon(iconName)}<span>${label}</span></a>`
}

function sidebar(options: LayoutOptions): string {
  const user = options.user
  if (!user) return ''

  const logout = options.csrf
    ? `<form method="post" action="/admin/logout" class="inline">
         <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf)}">
         <button type="submit" class="nav-link as-button">${icon('logout')}<span>Log out</span></button>
       </form>`
    : ''

  return `<aside class="sidebar" id="sidebar">
    <a class="brand" href="/admin">
      <span class="brand-mark">M</span>
      <span>MungilBase<small>admin</small></span>
    </a>
    <nav class="nav" aria-label="Main">
      ${navItem('/admin', 'Data', 'table', options.active === 'tables')}
      ${navItem('/admin/schema', 'Schema', 'sliders', options.active === 'schema')}
      ${navItem('/admin/settings', 'Settings', 'gear', options.active === 'settings')}
    </nav>
    <div class="sidebar-foot">
      <div class="who" title="${escapeHtml(user.email)}">
        <span class="avatar">${escapeHtml(user.email.slice(0, 1).toUpperCase())}</span>
        <span class="who-text"><strong>${escapeHtml(user.email)}</strong><small>${escapeHtml(user.role)}</small></span>
      </div>
      ${logout}
    </div>
  </aside>`
}

export function renderPage(options: LayoutOptions): string {
  const crumbs = options.breadcrumbs?.length
    ? `<div class="breadcrumbs">${options.breadcrumbs
        .map((crumb, index) =>
          crumb.href
            ? `<a href="${crumb.href}">${escapeHtml(crumb.label)}</a>${index < (options.breadcrumbs?.length ?? 0) - 1 ? '<span aria-hidden="true">/</span>' : ''}`
            : `<span>${escapeHtml(crumb.label)}</span>`,
        )
        .join('')}</div>`
    : ''

  const head = options.user
    ? `<header class="topbar">
        <button type="button" class="icon-btn mobile-only" data-sidebar-toggle aria-label="Toggle navigation">${icon('menu', 18)}</button>
        <div class="topbar-title">${escapeHtml(options.title)}</div>
        <div class="topbar-actions">
          <button type="button" class="icon-btn" data-theme-toggle aria-label="Toggle colour theme" title="Toggle colour theme">${icon('sun', 17)}${icon('moon', 17)}</button>
        </div>
      </header>`
    : ''

  const main = options.bare
    ? options.body
    : `<main class="page${options.wide ? ' wide' : ''}">${crumbs}${options.body}</main>`

  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(pagetitle(options.title))}</title>
  <link rel="stylesheet" href="/admin/assets/app.css">
  <script src="/admin/assets/app.js" defer></script>
</head>
<body class="${options.bare ? 'bare' : ''}">
  <div class="app${options.bare ? ' app-bare' : ''}">
    ${sidebar(options)}
    <div class="content">
      ${head}
      ${main}
    </div>
  </div>
</body>
</html>`
}

export function badge(text: string, tone: '' | 'ok' | 'off' | 'accent' | 'warn' = ''): string {
  return `<span class="badge${tone ? ` ${tone}` : ''}">${escapeHtml(text)}</span>`
}

export function alert(kind: 'error' | 'ok' | 'warn' | 'info', html: string): string {
  return `<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${html}</div>`
}

/** A short, human list of validation problems. Always escaped. */
export function issuesAlert(issues: readonly string[]): string {
  if (!issues.length) return ''
  const items = issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')
  return alert('error', `<strong>Could not save:</strong><ul>${items}</ul>`)
}

export function logoSvg(size = 34): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="url(#g)"/>
    <path d="M9 22V10l7 7 7-7v12" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
  </svg>`
}

/**
 * Client behaviour. Deliberately tiny: no framework, no fetch, no state.
 * Forms still work without it; it only adds convenience.
 */
export const ADMIN_JS = String.raw`(function () {
  'use strict'

  var THEME_KEY = 'mungil-admin-theme'

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
  }

  try {
    var saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') applyTheme(saved)
  } catch (error) {
    /* localStorage can be unavailable in private modes */
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  onReady(function () {
    var root = document.documentElement

    document.addEventListener('click', function (event) {
      var target = event.target
      if (!(target instanceof Element)) return

      var toggle = target.closest('[data-theme-toggle]')
      if (toggle) {
        var isDark = root.dataset.theme === 'dark' ||
          (root.dataset.theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
        var next = isDark ? 'light' : 'dark'
        applyTheme(next)
        try { localStorage.setItem(THEME_KEY, next) } catch (error) {}
        return
      }

      if (target.closest('[data-sidebar-toggle]')) {
        document.body.classList.toggle('sidebar-open')
        return
      }

      var removeField = target.closest('[data-remove-field]')
      if (removeField) {
        var row = removeField.closest('[data-field-row]')
        if (row) row.remove()
        return
      }

      var addField = target.closest('[data-add-field]')
      if (addField) {
        var template = document.getElementById('field-row-template')
        var list = document.querySelector('[data-field-list]')
        if (template && list) {
          list.appendChild(template.content.cloneNode(true))
          list.lastElementChild.querySelector('input, select').focus()
        }
        return
      }

      var preset = target.closest('[data-rule-set]')
      if (preset) {
        var input = document.getElementById(preset.getAttribute('data-rule-target') || '')
        if (input) {
          input.value = preset.getAttribute('data-rule-set') || ''
          input.focus()
        }
        return
      }

      if (document.body.classList.contains('sidebar-open') &&
          !target.closest('#sidebar') &&
          !target.closest('[data-sidebar-toggle]')) {
        document.body.classList.remove('sidebar-open')
      }
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
        document.body.classList.remove('sidebar-open')
      }
    })

    document.addEventListener('submit', function (event) {
      var form = event.target
      if (!(form instanceof HTMLFormElement)) return
      var message = form.getAttribute('data-confirm')
      if (message && !window.confirm(message)) event.preventDefault()
    })

    document.addEventListener('change', function (event) {
      var select = event.target
      if (!(select instanceof HTMLSelectElement) || select.getAttribute('data-field-type') === null) return
      var row = select.closest('[data-field-row]')
      if (!row) return
      var hints = row.querySelectorAll('[data-for-type]')
      for (var i = 0; i < hints.length; i += 1) {
        hints[i].hidden = hints[i].getAttribute('data-for-type') !== select.value
      }
    })

    var flash = document.querySelector('[data-flash]')
    if (flash) {
      window.setTimeout(function () {
        flash.classList.add('fading')
      }, 4000)
    }
  })
})()`

export const ADMIN_CSS = String.raw`:root {
  --bg: #f5f6f8;
  --panel: #ffffff;
  --panel-2: #f2f4f7;
  --border: #e2e6ec;
  --border-strong: #cfd6e0;
  --text: #14181f;
  --muted: #667085;
  --accent: #4f46e5;
  --accent-contrast: #ffffff;
  --accent-soft: #eef0ff;
  --sidebar-bg: #11141b;
  --sidebar-text: #b3bccb;
  --danger: #b42318;
  --danger-strong: #7a1710;
  --danger-soft: #fef3f2;
  --danger-border: #f4c7c3;
  --ok: #067647;
  --ok-soft: #ecfdf3;
  --warn: #93370d;
  --warn-soft: #fffaeb;
  --warn-border: #fedf89;
  --info-soft: #eff8ff;
  --info-border: #b2ddff;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 1px 3px rgba(16, 24, 40, .08);
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d1015;
    --panel: #151a22;
    --panel-2: #1b212c;
    --border: #263041;
    --border-strong: #33415a;
    --text: #e6eaf1;
    --muted: #93a0b4;
    --accent: #8b8cf8;
    --accent-contrast: #10131b;
    --accent-soft: #23244a;
    --sidebar-bg: #090b0f;
    --sidebar-text: #a7b1c2;
    --danger: #ff8a80;
    --danger-strong: #ffc9c4;
    --danger-soft: #2a1513;
    --danger-border: #5b2420;
    --ok: #6ee7a8;
    --ok-soft: #0f2a1e;
    --warn: #fbbf6b;
    --warn-soft: #2a2010;
    --warn-border: #5c4319;
    --info-soft: #122335;
    --info-border: #1e4b74;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4);
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --bg: #0d1015;
  --panel: #151a22;
  --panel-2: #1b212c;
  --border: #263041;
  --border-strong: #33415a;
  --text: #e6eaf1;
  --muted: #93a0b4;
  --accent: #8b8cf8;
  --accent-contrast: #10131b;
  --accent-soft: #23244a;
  --sidebar-bg: #090b0f;
  --sidebar-text: #a7b1c2;
  --danger: #ff8a80;
  --danger-strong: #ffc9c4;
  --danger-soft: #2a1513;
  --danger-border: #5b2420;
  --ok: #6ee7a8;
  --ok-soft: #0f2a1e;
  --warn: #fbbf6b;
  --warn-soft: #2a2010;
  --warn-border: #5c4319;
  --info-soft: #122335;
  --info-border: #1e4b74;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  color-scheme: dark;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14.5px/1.55 var(--font);
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); }
a:hover { text-decoration: underline; }
h1 { font-size: 1.4rem; line-height: 1.25; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1rem; margin: 0; }
h3 { font-size: .92rem; margin: 0 0 .5rem; }
p { margin: 0 0 .6rem; }
p:last-child { margin-bottom: 0; }

code, .mono {
  font-family: var(--mono);
  font-size: .84em;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: .05rem .3rem;
  word-break: break-word;
}

.muted { color: var(--muted); }
.small { font-size: .84rem; }
.nowrap { white-space: nowrap; }
.inline { display: inline; }
.icon { flex: none; }

/* Shell ------------------------------------------------------------------ */
.app {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--sidebar-bg);
  color: var(--sidebar-text);
  border-right: 1px solid rgba(255, 255, 255, .06);
  z-index: 20;
}

.brand {
  display: flex;
  align-items: center;
  gap: .65rem;
  padding: 1.05rem 1rem;
  color: #fff;
  text-decoration: none;
  font-weight: 700;
  letter-spacing: -.01em;
}
.brand:hover { text-decoration: none; }
.brand small {
  display: block;
  font-size: .68rem;
  font-weight: 500;
  color: var(--sidebar-text);
  letter-spacing: .08em;
  text-transform: uppercase;
}
.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-size: .95rem;
  font-weight: 800;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #22d3ee);
}

.nav { display: flex; flex-direction: column; gap: 2px; padding: .5rem .6rem; }
.nav a, .nav-link {
  display: flex;
  align-items: center;
  gap: .65rem;
  padding: .52rem .7rem;
  border-radius: 8px;
  color: var(--sidebar-text);
  text-decoration: none;
  font-weight: 500;
  font-size: .92rem;
  border: 0;
  background: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}
.nav a:hover, .nav-link:hover { background: rgba(255, 255, 255, .07); color: #fff; text-decoration: none; }
.nav a.active {
  background: rgba(99, 102, 241, .22);
  color: #fff;
  box-shadow: inset 2px 0 0 #818cf8;
}

.sidebar-foot {
  margin-top: auto;
  padding: .75rem;
  border-top: 1px solid rgba(255, 255, 255, .08);
  display: flex;
  flex-direction: column;
  gap: .45rem;
}
.who { display: flex; align-items: center; gap: .55rem; min-width: 0; padding: 0 .25rem; }
.avatar {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #2b3240;
  color: #e8edf5;
  font-weight: 700;
  font-size: .8rem;
}
.who-text { min-width: 0; }
.who-text strong {
  display: block;
  color: #e8edf5;
  font-size: .82rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who-text small { color: var(--sidebar-text); font-size: .72rem; }

.content { min-width: 0; display: flex; flex-direction: column; }

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: .75rem;
  padding: .55rem 1.25rem;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  min-height: 52px;
}
.topbar-title { font-weight: 600; font-size: .92rem; color: var(--muted); }
.topbar-actions { margin-left: auto; display: flex; gap: .3rem; align-items: center; }
[data-theme-toggle] .icon:last-child { display: none; }
[data-theme="dark"] [data-theme-toggle] .icon:first-child { display: none; }
[data-theme="dark"] [data-theme-toggle] .icon:last-child { display: block; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) [data-theme-toggle] .icon:first-child { display: none; }
  :root:not([data-theme="light"]) [data-theme-toggle] .icon:last-child { display: block; }
}

.page { padding: 1.4rem 1.25rem 3rem; width: 100%; max-width: 1080px; margin: 0 auto; flex: 1; }
.page.wide { max-width: 1240px; }

.breadcrumbs {
  display: flex;
  align-items: center;
  gap: .35rem;
  font-size: .82rem;
  color: var(--muted);
  margin-bottom: .45rem;
  flex-wrap: wrap;
}
.breadcrumbs a { color: var(--muted); text-decoration: none; }
.breadcrumbs a:hover { color: var(--accent); }

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.2rem;
}
.page-head .sub { color: var(--muted); margin: 0; font-size: .9rem; }
.page-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

/* Cards ------------------------------------------------------------------ */
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  margin-bottom: 1rem;
  overflow: hidden;
}
.card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  padding: .8rem 1rem;
  border-bottom: 1px solid var(--border);
}
.card > header h2 { font-size: .95rem; font-weight: 650; }
.card-body { padding: 1rem; }
.card-body.tight { padding: .5rem; }
.card-foot {
  padding: .75rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
  display: flex;
  gap: .5rem;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }

.tile {
  display: block;
  padding: .95rem 1rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  color: inherit;
  text-decoration: none;
  transition: border-color .12s ease, transform .12s ease, box-shadow .12s ease;
}
.tile:hover {
  text-decoration: none;
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(79, 70, 229, .12);
}
.tile-title { display: flex; align-items: center; gap: .45rem; font-weight: 650; margin-bottom: .15rem; }
.tile-title .icon { color: var(--muted); }
.tile .meta { color: var(--muted); font-size: .82rem; margin-top: .55rem; display: flex; gap: .35rem; flex-wrap: wrap; }

.badge {
  display: inline-flex;
  align-items: center;
  gap: .25rem;
  padding: .05rem .45rem;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--panel-2);
  color: var(--muted);
  font-size: .72rem;
  font-weight: 600;
  line-height: 1.55;
  white-space: nowrap;
}
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.badge.off { color: var(--muted); background: var(--panel-2); border-color: var(--border); }
.badge.accent { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-border); }

.rule-row { display: flex; align-items: center; gap: .4rem; justify-content: space-between; padding: .28rem 0; }
.rule-row .name { font-size: .82rem; color: var(--muted); min-width: 3.4rem; }
.rule-row code { font-size: .78rem; }

/* Buttons ---------------------------------------------------------------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .4rem;
  padding: .45rem .8rem;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: .88rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: var(--panel-2); text-decoration: none; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
.btn-primary:hover { background: var(--accent); filter: brightness(1.06); }
.btn-danger { color: var(--danger); border-color: var(--danger-border); }
.btn-danger:hover { background: var(--danger-soft); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn-ghost:hover { background: var(--panel-2); color: var(--text); }
.btn-sm { padding: .28rem .55rem; font-size: .8rem; border-radius: 7px; }
.btn[disabled] { opacity: .55; cursor: not-allowed; }

.icon-btn {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}
.icon-btn:hover { background: var(--panel-2); color: var(--text); }
.icon-btn.danger:hover { background: var(--danger-soft); color: var(--danger); }

/* Forms ------------------------------------------------------------------ */
.field { display: flex; flex-direction: column; gap: .3rem; margin-bottom: .85rem; }
.field:last-child { margin-bottom: 0; }
.field > label, .label { font-weight: 600; font-size: .85rem; }
.field .hint, .hint { color: var(--muted); font-size: .78rem; line-height: 1.45; }

input[type="text"], input[type="password"], input[type="email"], input[type="number"], input[type="url"], select, textarea {
  width: 100%;
  padding: .48rem .6rem;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: .9rem;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
input:disabled, select:disabled { background: var(--panel-2); color: var(--muted); }
textarea { font-family: var(--mono); font-size: .84rem; min-height: 2.6rem; resize: vertical; }
textarea.code { min-height: 4.5rem; }
input[type="checkbox"] { width: auto; accent-color: var(--accent); }

.form-grid { display: grid; gap: 0 1rem; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
.actions:first-child { margin-top: 0; }

/* Data tables ------------------------------------------------------------ */
.table-wrap {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: auto;
  box-shadow: var(--shadow);
}
table.data { width: 100%; border-collapse: collapse; font-size: .88rem; }
.data th {
  text-align: left;
  font-size: .72rem;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: var(--muted);
  padding: .55rem .7rem;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.data td { padding: .5rem .7rem; border-bottom: 1px solid var(--border); vertical-align: top; max-width: 22rem; }
.data tbody tr:last-child td { border-bottom: 0; }
.data tbody tr:hover td { background: var(--panel-2); }
.data td.actions-cell { text-align: right; white-space: nowrap; }

.pager {
  display: flex;
  gap: .5rem;
  align-items: center;
  justify-content: flex-end;
  padding: .6rem .15rem 0;
  color: var(--muted);
  font-size: .82rem;
  flex-wrap: wrap;
}

.empty { padding: 2.6rem 1rem; text-align: center; color: var(--muted); }
.empty .icon { width: 30px; height: 30px; margin-bottom: .5rem; color: var(--border-strong); }
.empty h3 { margin: 0 0 .25rem; color: var(--text); }
.empty p { margin: 0 auto .9rem; max-width: 30rem; font-size: .88rem; }

/* Alerts ----------------------------------------------------------------- */
.alert {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: .65rem .85rem;
  margin-bottom: 1rem;
  font-size: .88rem;
  background: var(--panel);
}
.alert ul { margin: .35rem 0 0; padding-left: 1.2rem; }
.alert-error { background: var(--danger-soft); border-color: var(--danger-border); color: var(--danger-strong); }
.alert-ok { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.alert-warn { background: var(--warn-soft); border-color: var(--warn-border); color: var(--warn); }
.alert-info { background: var(--info-soft); border-color: var(--info-border); color: var(--text); }
.alert.fading { transition: opacity .6s ease; opacity: 0; }

/* Definition lists ------------------------------------------------------- */
.dl { display: grid; grid-template-columns: minmax(140px, 200px) minmax(0, 1fr); gap: .45rem .9rem; font-size: .88rem; margin: 0; }
.dl dt { color: var(--muted); }
.dl dd { margin: 0; min-width: 0; }
@media (max-width: 640px) { .dl { grid-template-columns: 1fr; gap: 0 0; } .dl dt { margin-top: .5rem; } }

.split { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr) 320px; align-items: start; }
@media (max-width: 980px) { .split { grid-template-columns: minmax(0, 1fr); } }

/* Rules editor ----------------------------------------------------------- */
.rules { display: grid; gap: .55rem; }
.rule { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: .6rem; align-items: start; }
.rule > .name { padding-top: .5rem; font-weight: 600; font-size: .84rem; text-transform: capitalize; }
.presets { display: flex; gap: .3rem; flex-wrap: wrap; margin-top: .3rem; }
.chip {
  font: inherit;
  font-size: .72rem;
  font-weight: 600;
  padding: .1rem .45rem;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--panel-2);
  color: var(--muted);
  cursor: pointer;
}
.chip:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
@media (max-width: 700px) { .rule { grid-template-columns: 1fr; } .rule > .name { padding-top: 0; } }

/* Field editor ----------------------------------------------------------- */
.field-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: .7rem .75rem;
  background: var(--panel);
  margin-bottom: .6rem;
}
.field-row:last-child { margin-bottom: 0; }
.field-row-main {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, .7fr) minmax(0, .7fr) minmax(0, 1.2fr) auto;
  gap: .5rem;
  align-items: end;
}
.field-row-main .field { margin-bottom: 0; }
.field-adv { margin-top: .55rem; }
.field-adv summary {
  cursor: pointer;
  font-size: .78rem;
  color: var(--muted);
  font-weight: 600;
  user-select: none;
}
.field-adv-grid { display: grid; gap: .55rem; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin-top: .55rem; }
.field-adv-grid .field { margin-bottom: 0; }
@media (max-width: 860px) {
  .field-row-main { grid-template-columns: 1fr 1fr; }
  .field-row-main .field:first-child { grid-column: 1 / -1; }
}

/* Auth pages ------------------------------------------------------------- */
body.bare { background: radial-gradient(1200px 600px at 50% -10%, var(--accent-soft), transparent 60%), var(--bg); }
.app-bare { display: block; }
.auth-wrap { min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; }
.auth-card {
  width: 100%;
  max-width: 400px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(16, 24, 40, .1);
  padding: 1.6rem;
}
.auth-brand { display: flex; align-items: center; gap: .7rem; margin-bottom: 1.2rem; }
.auth-brand strong { font-size: 1.02rem; }
.auth-brand span small { display: block; color: var(--muted); font-size: .78rem; font-weight: 500; }
.auth-card h1 { font-size: 1.2rem; }
.auth-card .sub { color: var(--muted); font-size: .88rem; margin-bottom: 1rem; }
.auth-card .btn { width: 100%; }

.kbd {
  font-family: var(--mono);
  font-size: .72rem;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 5px;
  padding: 0 .3rem;
  color: var(--muted);
}

.mobile-only { display: none; }
@media (max-width: 900px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: 248px;
    transform: translateX(-100%);
    transition: transform .18s ease;
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0);
  }
  body.sidebar-open .sidebar { transform: translateX(0); box-shadow: 0 10px 40px rgba(0, 0, 0, .35); }
  body.sidebar-open::after {
    content: "";
    position: fixed;
    inset: 0;
    background: rgba(9, 11, 15, .45);
    z-index: 15;
  }
  .mobile-only { display: inline-grid; }
  .page { padding: 1rem .9rem 2.5rem; }
  .topbar { padding: .5rem .9rem; }
}
`
