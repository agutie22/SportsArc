/**
 * A pickup game opened from Home: the game sheet (when, spots, level,
 * venue, who's playing) as a modal, with the same buttons the Games page
 * gives it (Join, Join waitlist, Register, Check in, Leave, Manage, Sides /
 * Result), run by the same code (game-card.js gameActions), plus "Open in
 * Games" to see it there.
 *
 * Every Home link to a game (#/games/<id>: stories, Your games, Games near
 * you, a post's game) opens here first; feed.js routes the clicks and passes
 * `onChange`, which reloads what Home shows after a join or a leave. The
 * link keeps its href, so a new tab or a copied link still goes to Games.
 */

import { openGameSheet } from "./game-sheet.js";
import { gameActions, paintedGame, sheetControls } from "./game-card.js";
import { openHostForm } from "./host.js";
import { esc, loadMeta } from "./api.js";
import { toast } from "./shared.js";

export function openGamePreview(id, { onChange } = {}) {
  const refresh = async () => { await onChange?.(); };
  const handle = gameActions({
    refresh,
    // Manage's "Host again": the host form, copied from this game.
    hostAgain: async (game) => {
      try {
        openHostForm({ meta: await loadMeta(), again: game, onPosted: () => void refresh() });
      } catch (err) {
        toast(err.message);
      }
    },
  });
  openGameSheet(id, {
    modal: true,
    painted: paintedGame,
    controlsOf: (g) => {
      const c = sheetControls(g);
      // The next step is the sheet's main button when there is one; otherwise Open in Games is.
      // A link: following it changes the route, and app.js closes every sheet on a route change.
      const link = c.main
        ? `<a class="btn-game btn-game-ghost" href="#/games/${esc(g.id)}">Open in Games</a>`
        : `<a class="btn-game" data-primary href="#/games/${esc(g.id)}">Open in Games</a>`;
      return { ...c, link };
    },
    handle,
  });
}
