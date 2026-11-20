/**
 * Loads every route module; each registers its routes at import time.
 * Importing this starts no timer and opens no database connection.
 */

import "../web3/index.js";
import "./health.js";
import "./auth.js";
import "./admin.js";
import "./venues.js";
import "./orgs.js";
import "./leagues.js";
import "./tryouts.js";
import "./insights.js";
import "./games.js";
import "./people.js";
import "./teams.js";
import "./notifications.js";
import "./posts.js";
import "./uploads.js";
import "./ingest.js";
import "./client-errors.js";
import "../markets/routes.js";
