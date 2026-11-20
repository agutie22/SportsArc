/**
 * Organizations: leagues, clubs, venues, sponsors and schools (api/orgs).
 *
 *   #/org/<slug>          the public org page; opens signed out (guest)
 *   #/org/<slug>/manage   the staff console (org.js): Staff, with the rest
 *                         of an org's work added as tabs by kind
 *   #/orgs                your organizations and invitations (mine.js)
 *   #/orgs/new            create one
 *   #/orgs/invites        the invitations list (the org_invite notification)
 *   #/orgs/signin/<page>  needs an account, then returns to <page> (how a
 *                         signed-out "Sign in" lands back where it was)
 *   #/season/<id>, #/team/<id>, #/join/<code>   league pages (league.js);
 *                         open signed out
 *   #/tryout/<id>         a club's tryout (tryout.js); opens signed out
 *
 * Home gets one line on the me card: your orgs, or an invitation waiting.
 */

import { registerHomeSection, registerModule } from "../modules.js";
import { renderOrgRoute } from "./org.js";
import { renderMeCardLine, renderOrgsRoute } from "./mine.js";
import { renderJoinRoute, renderSeasonRoute, renderTeamRoute } from "./league.js";
import { renderTryoutRoute } from "./tryout.js";

registerModule({
  id: "org",
  path: "/org",
  prefix: true,
  guest: true,
  nav: false,
  stylesheet: "/orgs/orgs.css",
  render: renderOrgRoute,
});

registerModule({
  id: "orgs",
  path: "/orgs",
  prefix: true,
  nav: false,
  tab: "profile",
  render: renderOrgsRoute,
});

for (const [id, render] of [["season", renderSeasonRoute], ["team", renderTeamRoute], ["join", renderJoinRoute], ["tryout", renderTryoutRoute]]) {
  registerModule({ id, path: `/${id}`, prefix: true, guest: true, nav: false, render });
}

registerHomeSection({ id: "orgs", meCard: renderMeCardLine });
