/**
 * Minimal route table with :param support, so route modules can register
 * endpoints without pulling in a web framework.
 *
 * A param named `:id` is a row id and matches only a uuid, so a bad id is a
 * 404 here rather than a Postgres error (a 500) in the handler. A param
 * that is not valid percent-encoding matches nothing either.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isUuid } from "./validate.js";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function split(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function route(method: string, pattern: string, handler: RouteHandler): void {
  routes.push({ method, pattern, segments: split(pattern), handler });
}

export const get = (p: string, h: RouteHandler) => route("GET", p, h);
export const post = (p: string, h: RouteHandler) => route("POST", p, h);
export const patch = (p: string, h: RouteHandler) => route("PATCH", p, h);
export const del = (p: string, h: RouteHandler) => route("DELETE", p, h);

export interface Matched {
  handler: RouteHandler;
  params: Record<string, string>;
  /** The pattern as registered, e.g. "/api/games/:id/join" (for logs). */
  pattern: string;
}

/** The params `parts` gives route `r`, or null when it does not fit. */
function bind(r: Route, parts: string[]): Record<string, string> | null {
  if (r.segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < r.segments.length; i++) {
    const seg = r.segments[i];
    if (!seg.startsWith(":")) {
      if (seg !== parts[i]) return null;
      continue;
    }
    let value: string;
    try {
      value = decodeURIComponent(parts[i]);
    } catch {
      return null;
    }
    if (seg === ":id" && !isUuid(value)) return null;
    params[seg.slice(1)] = value;
  }
  return params;
}

export function match(method: string, pathname: string): Matched | null {
  const parts = split(pathname);
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = bind(r, parts);
    if (params) return { handler: r.handler, params, pattern: r.pattern };
  }
  return null;
}

/** Every registered route, in registration order. */
export function listRoutes(): { method: string; pattern: string }[] {
  return routes.map(({ method, pattern }) => ({ method, pattern }));
}

/** True when any route exists at this path under a different method. */
export function pathExists(pathname: string): boolean {
  const parts = split(pathname);
  return routes.some((r) => bind(r, parts) !== null);
}
