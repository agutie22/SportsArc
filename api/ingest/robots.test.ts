/**
 * Crawl-delay spacing in robots.ts: successive fetches to one origin wait
 * their turn, and a delay too long to sit through is refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CRAWL_WAIT_MS, parseRobots, waitTurn } from "./robots.js";

test("Crawl-delay is parsed in milliseconds", () => {
  assert.equal(parseRobots("User-agent: *\nCrawl-delay: 2\n", "SportsArcBot").crawlDelayMs, 2000);
});

test("fetches to one origin are spaced by the crawl delay", async () => {
  const url = "https://spacing.example/feed";
  const start = Date.now();
  assert.equal(await waitTurn(url, 50), true);
  assert.equal(await waitTurn(url, 50), true);
  assert.equal(await waitTurn(url, 50), true);
  assert.ok(Date.now() - start >= 95, "second and third fetch each waited");
});

test("other origins do not wait on each other", async () => {
  const start = Date.now();
  await Promise.all([waitTurn("https://a.example/", 200), waitTurn("https://b.example/", 200)]);
  assert.ok(Date.now() - start < 100);
});

test("a wait longer than the cap is refused without taking a slot", async () => {
  const url = "https://slow.example/feed";
  assert.equal(await waitTurn(url, 0), true);
  assert.equal(await waitTurn(url, MAX_CRAWL_WAIT_MS + 1000), false);
  assert.equal(await waitTurn(url, 0), true);
});
