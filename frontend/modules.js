/**
 * Optional feature modules.
 *
 * The core app ships without Research; it lives on the x402 branch, where
 * the free tools and the paid/x402 ones belong together. A module supplies
 * its own route and nav tab, so enabling one is a single entry in
 * modules.enabled.js rather than edits scattered through app.js,
 * index.html and styles.css.
 *
 * Keeping that seam here is what lets the branch stay a small additive
 * diff against main instead of fighting the same files forever.
 */

const registry = [];

/**
 * @param {{
 *   id: string,            // nav/route key, e.g. "research"
 *   label?: string,        // tab text (needed only with a nav tab)
 *   path: string,          // hash path, e.g. "/research"
 *   render: () => void,    // paints into #main-content
 *   featured?: boolean,    // accent styling on the tab
 *   stylesheet?: string,   // optional css to inject once
 *   nav?: boolean,         // false: a route only, no nav tab (e.g. a link into Home)
 *   tab?: string,          // with nav: false, the nav tab to light up
 *   prefix?: boolean,      // owns path and everything under it; render(rest, { guest })
 *   guest?: boolean,       // signed-out visitors may open it (no tabs, no account menu)
 * }} mod
 */
export function registerModule(mod) {
  if (!mod?.id || !mod.path || typeof mod.render !== "function") {
    console.warn("[modules] ignoring malformed module:", mod);
    return;
  }
  if (registry.some((m) => m.id === mod.id)) return;
  registry.push(mod);
  if (mod.stylesheet) injectStylesheet(mod.stylesheet);
}

function injectStylesheet(href) {
  if (document.querySelector(`link[data-module-css="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.moduleCss = href;
  document.head.appendChild(link);
}

/** Modules that get a nav tab. */
export const listModules = () => registry.filter((m) => m.nav !== false);

// ── sport page sections ───────────────────────────────────────────────

const sections = [];

/**
 * A section a module adds to the Games page for a chosen sport (games.js),
 * e.g. Pro markets. Every function gets the sport, or "" for ALL. Games
 * stays whole without any.
 *
 * @param {{
 *   id: string,
 *   tabLabel?: string,                       // adds a Games · <tabLabel> switch
 *   stylesheet?: string,
 *   visible?: (sport: string) => Promise<boolean>, // false hides every part of the section
 *   strip?: (sport: string, el: HTMLElement) => void,  // the band under the sport tabs
 *   tab?: (sport: string, el: HTMLElement) => void,    // the view behind the tabLabel switch
 *   rail?: (sport: string, el: HTMLElement) => void,   // beside that view (above it on phones)
 *   onEnter?: (sport: string, params: URLSearchParams) => void, // a link's query, once
 *   prefetch?: (sport: string) => void,      // load ahead of a click on that sport's tab
 * }} section
 */
export function registerSportSection(section) {
  if (!section?.id || sections.some((s) => s.id === section.id)) return;
  sections.push(section);
  if (section.stylesheet) injectStylesheet(section.stylesheet);
}

export const listSportSections = () => [...sections];

/** Route table fragment: { "/research": { render } }. Prefix modules are in modulePrefixRoutes. */
export function moduleRoutes() {
  return Object.fromEntries(registry.filter((m) => !m.prefix)
    .map((m) => [m.path, { render: m.render, ...(m.tab ? { tab: m.tab } : {}) }]));
}

/**
 * A module registered with `prefix: true` owns its path and everything
 * under it (#/org, #/org/<slug>, #/org/<slug>/manage); its render gets
 * what follows "<path>/" and { guest }. Same shape as app.js PREFIX_ROUTES.
 */
export function modulePrefixRoutes() {
  return registry.filter((m) => m.prefix).map((m) => ({
    prefix: `${m.path}/`,
    tab: m.tab ?? null,
    match: (path) => path === m.path || path.startsWith(`${m.path}/`),
    render: m.render,
  }));
}

/**
 * May a signed-out visitor open this path? Yes when a module registered
 * it with `guest: true`; its render then gets { guest: true } and must work
 * with no user (app.js isSharedPath asks this).
 */
export function isGuestModulePath(path) {
  return registry.some((m) => m.guest && (path === m.path || (m.prefix && path.startsWith(`${m.path}/`))));
}

// ── Home sections ─────────────────────────────────────────────────────

const homeSections = [];

/**
 * A section a module adds to Home (feed.js), e.g. Pro markets. Home stays
 * whole without any, and feed.js never names one: it draws empty slots and
 * calls these. Every part is optional.
 *
 * @param {{
 *   id: string,
 *   stylesheet?: string,
 *   visible?: () => Promise<boolean>,          // false: none of the parts are drawn
 *   widget?: { title: string, render: (body: HTMLElement, section: HTMLElement) => void },
 *                                               // a right-rail widget, first in the rail
 *   meCard?: (el: HTMLElement) => void,         // a line on the left "me" card
 *   feedTab?: {                                 // a tab after Following · Latest
 *     id: string, label: string,
 *     render: (el: HTMLElement, rail: HTMLElement, view: string | null) => void,
 *                                               // el replaces stories/composer/posts; rail the right rail
 *   },
 * }} section
 */
export function registerHomeSection(section) {
  if (!section?.id || homeSections.some((s) => s.id === section.id)) return;
  homeSections.push(section);
  if (section.stylesheet) injectStylesheet(section.stylesheet);
}

export const listHomeSections = () => [...homeSections];

/**
 * A link into Home asks for a module's feed tab (e.g. #/markets/picks):
 * the route stores the ask here and sends the browser to #/, so Home stays
 * one page with one cached copy. renderHome/resumeHome take it once.
 */
let homeAsk = null;
export function askHomeTab(tab, view = null) {
  homeAsk = { tab, view };
}
export function takeHomeAsk() {
  const a = homeAsk;
  homeAsk = null;
  return a;
}

/** Load whatever modules.enabled.js lists. Failure is never fatal. */
export async function loadEnabledModules() {
  let enabled = [];
  try {
    ({ ENABLED_MODULES: enabled = [] } = await import("./modules.enabled.js"));
  } catch (err) {
    console.warn("[modules] no module manifest:", err);
    return;
  }
  for (const load of enabled) {
    try {
      await load();
    } catch (err) {
      console.error("[modules] failed to load a module:", err);
    }
  }
}
