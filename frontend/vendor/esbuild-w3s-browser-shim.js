// Injected ahead of bundled W3S SDK so jsonwebtoken / jws Node shims resolve in the browser.
import process from "process/browser";
import { Buffer } from "buffer";

if (typeof globalThis.process === "undefined") {
  globalThis.process = process;
}
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
