/**
 * Pro markets: Gemini prediction markets on Home and on the Games page.
 *
 * On Home it registers a home section (modules.js; home.js): "Tonight on
 * Gemini" in the rail and the Markets feed tab with Your picks, plus
 * #/markets and #/markets/picks, links that open that tab.
 *
 * On Games it registers one sport section, which games.js shows:
 *
 *   strip     the scoreboard of upcoming games, under the sport tabs
 *             (under ALL, every sport's next games mixed)
 *   tab       "Markets": the featured game, then games, totals and spreads;
 *             under ALL, each sport's featured game (all.js)
 *   rail      the account card and positions, beside the Markets view
 *   prefetch  load a sport's markets before its tab is clicked
 *
 * Shown only to adults (the server decides: GET /api/markets/me answers
 * { allowed: false } for anyone else) and only on sports Gemini lists
 * (meta.marketSports). Everything else lives in this folder; the API side is
 * api/markets.
 */

import { askHomeTab, registerHomeSection, registerModule, registerSportSection } from "../modules.js";
import { renderMarketsTab, renderTonight } from "./home.js";
import { loadMeta } from "../api.js";
import { toast } from "../shared.js";
import { forgetMe, me, prefetch } from "./client.js";
import { renderAllTab } from "./all.js";
import { renderStrip } from "./strip.js";
import { renderTab } from "./tab.js";
import { renderRail } from "./rail.js";

const CONNECT_ERRORS = {
  DECLINED: "Gemini connection cancelled.",
  STATE_MISMATCH: "That Gemini sign-in expired. Try connecting again.",
  MARKETS_NOT_ALLOWED: "Pro markets are for adults only.",
  NOT_OAUTH: "Connecting Gemini accounts is not switched on.",
};

/** Adults, with markets switched on and some sport listed. */
async function shown() {
  const [meta, account] = await Promise.all([loadMeta(), me()]);
  return Boolean(account.allowed && account.enabled && (meta.marketSports ?? []).length > 0);
}

// Home (feed.js): "Tonight on Gemini" and the Markets tab; see home.js.
registerHomeSection({
  id: "markets",
  stylesheet: "/markets/markets.css",
  visible: shown,
  widget: { title: "Tonight on Gemini", render: renderTonight },
  feedTab: { id: "markets", label: "Markets", render: renderMarketsTab },
});

// Links into Home's Markets tab: Tonight on Gemini, the settled
// notification. They set the tab and land on #/, so Home stays one page.
const intoHome = (view) => () => {
  askHomeTab("markets", view);
  location.replace("#/");
};
registerModule({ id: "markets-home", path: "/markets", nav: false, tab: "home", render: intoHome("games") });
registerModule({ id: "markets-picks", path: "/markets/picks", nav: false, tab: "home", render: intoHome("picks") });

registerSportSection({
  id: "markets",
  tabLabel: "Markets",
  stylesheet: "/markets/markets.css",

  // ALL ("") shows markets whenever any sport has them.
  visible: async (sport) => {
    const [meta, account] = await Promise.all([loadMeta(), me()]);
    const sports = meta.marketSports ?? [];
    return Boolean(account.allowed && account.enabled && (sport ? sports.includes(sport) : sports.length > 0));
  },

  strip: renderStrip,
  tab: (sport, el) => (sport ? renderTab(sport, el) : renderAllTab(sport, el)),
  rail: renderRail,

  prefetch: async (sport) => {
    const [meta, account] = await Promise.all([loadMeta(), me()]);
    if (account.allowed && account.enabled && (meta.marketSports ?? []).includes(sport)) prefetch(sport);
  },

  onEnter: (sport, params) => {
    const g = params.get("gemini");
    if (g === "connected") {
      forgetMe();
      toast("Gemini connected");
    } else if (g === "error") {
      toast(CONNECT_ERRORS[params.get("code")] ?? "Could not connect Gemini. Try again.");
    }
  },
});
