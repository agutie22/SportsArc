/**
 * Manage the private-beta allowlist from the command line, e.g. inside the
 * API container on the server, with the same env as the API.
 *
 *   node --env-file=.env --import=tsx scripts/invite.ts add <email> [note...]
 *   node --env-file=.env --import=tsx scripts/invite.ts list
 *   node --env-file=.env --import=tsx scripts/invite.ts remove <email>
 *
 * (In a container whose env is already set, drop --env-file=.env.)
 * Removing an invite never removes an account that already signed up.
 */

import { initDb } from "../api/db.js";
import { addInvite, inviteOnlyEnabled, listInvites, removeInvite } from "../api/auth/invites.js";

const USAGE = `usage: scripts/invite.ts add <email> [note] | list | remove <email>`;

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "add" && command !== "list" && command !== "remove") {
    console.error(USAGE);
    return 2;
  }
  const orm = await initDb();
  const em = orm.em.fork();
  try {
    if (command === "list") {
      const invites = await listInvites(em);
      if (!inviteOnlyEnabled()) console.log("(BETA_INVITE_ONLY is off: anyone can sign up right now)");
      if (!invites.length) console.log("no invites");
      for (const i of invites) {
        const when = i.createdAt.slice(0, 10);
        const by = i.invitedBy ? ` by ${i.invitedBy}` : "";
        console.log(`${i.status.padEnd(8)} ${i.email}  ${when}${by}${i.note ? `  "${i.note}"` : ""}`);
      }
      return 0;
    }
    const email = args[0];
    if (!email) {
      console.error(USAGE);
      return 2;
    }
    if (command === "add") {
      const r = await addInvite(em, { email, note: args.slice(1).join(" ") }, null);
      if (!r.ok) {
        console.error(`${r.error.code}: ${r.error.message}`);
        return 1;
      }
      console.log(`${r.created ? "invited" : "already invited"} ${r.invite.email} (${r.invite.status})`);
      return 0;
    }
    const r = await removeInvite(em, { email });
    if (!r.ok) {
      console.error(`${r.error.code}: ${r.error.message}`);
      return 1;
    }
    console.log(`removed ${email.trim().toLowerCase()}`);
    return 0;
  } finally {
    await orm.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
