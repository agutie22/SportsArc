/**
 * Static checks for the frontend, which has no build step and so no
 * compiler to catch these.
 *
 *  1. every named import resolves to a real export
 *  2. every $("#id") the JS binds unguarded exists in index.html
 *  3. every function called in a file is defined, imported, or a global
 *  4. nothing is imported and then never used
 *  5. every id in index.html is referenced from JS, CSS or the page
 *  6. every module parses (node --check), which the text scans above cannot
 *     see: a duplicate declaration loads nothing and blanks every page
 *
 * Check 3 exists because an edit once deleted the router while leaving its
 * call sites behind: the app loaded, the header rendered, and every page
 * was blank with no error visible until the console was opened.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const DIR = "frontend";
const ID = String.raw`[A-Za-z_$][\w$]*`;
/**
 * Includes feature-module subdirectories such as research/, which only
 * exist on some branches. Leaving them out once meant deleting ICON entries
 * that looked unused but were not.
 */
function jsFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(join(dir, prefix) || dir)) {
    if (name.startsWith("_") || name === "vendor" || name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...jsFiles(dir, rel));
    else if (name.endsWith(".js")) out.push(rel);
  }
  return out;
}
const files = jsFiles(DIR);
const problems = [];

const read = (f) => readFileSync(join(DIR, f), "utf8");
const code = (f) => stripNonCode(read(f));

/**
 * Blank out comments and string bodies so the scans below see code only.
 * Characters are replaced with spaces rather than removed, so reported
 * line numbers still match the file.
 *
 * Template interpolations return to code mode, because real calls live
 * inside them and the strings nested within them (CSS such as "var(--x)")
 * must still be stripped.
 */
function stripNonCode(src) {
  const out = src.split("");
  const blank = (i) => { if (src[i] !== "\n") out[i] = " "; };
  const stack = [];              // template-literal depths we can return to
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") blank(i++); continue; }
    if (c === "/" && d === "*") {
      blank(i++); blank(i++);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      blank(i++); blank(i++); continue;
    }
    if (c === '"' || c === "'") {
      const q = c; blank(i++);
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") blank(i++); blank(i++); }
      blank(i++); continue;
    }
    if (c === "`") { blank(i++); stack.push({ depth: 0 }); i = scanTemplate(src, out, blank, i, stack); continue; }
    if (c === "}" && stack.length && stack[stack.length - 1].inExpr) {
      stack[stack.length - 1].inExpr = false;
      i = scanTemplate(src, out, blank, i + 1, stack);
      continue;
    }
    i++;
  }
  return out.join("");

  function scanTemplate(s2, o, bl, j, st) {
    while (j < s2.length) {
      if (s2[j] === "\\") { bl(j++); bl(j++); continue; }
      if (s2[j] === "`") { bl(j++); st.pop(); return j; }
      if (s2[j] === "$" && s2[j + 1] === "{") {
        st[st.length - 1].inExpr = true;
        return j + 2;            // hand control back to the code scanner
      }
      bl(j++);
    }
    return j;
  }
}




// ── exports per module ────────────────────────────────────────────────
const exports = new Map();
for (const f of files) {
  const s = read(f);
  const names = new Set([
    ...s.matchAll(new RegExp(String.raw`export\s+(?:async\s+)?function\s+(${ID})`, "g")),
    ...s.matchAll(new RegExp(String.raw`export\s+(?:const|let|var|class)\s+(${ID})`, "g")),
  ].map((m) => m[1]));
  for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(" as ").pop()?.trim();
      if (n) names.add(n);
    }
  }
  exports.set(f, names);
}

// ── 1. imports resolve ────────────────────────────────────────────────
for (const f of files) {
  const s = read(f);
  for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.\.?\/[^"']+)["']/g)) {
    // resolve the specifier relative to the importing file
    const dirOf = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    const src = join(dirOf, m[2]).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!exports.has(src)) { problems.push(`${f}: imports from missing module ./${src}`); continue; }
    for (const part of m[1].split(",")) {
      const n = part.trim().split(" as ")[0]?.trim();
      if (n && !exports.get(src).has(n)) problems.push(`${f}: '${n}' is not exported by ./${src}`);
    }
  }
}

// ── 2. bound element ids exist ────────────────────────────────────────
const html = readFileSync(join(DIR, "index.html"), "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const f of files) {
  const raw = read(f);
  const s = code(f);
  // ids the file creates itself are fine
  const created = new Set([...raw.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  for (const m of s.matchAll(/\$\("#([\w-]+)"\)(\s*\??\.)/g)) {
    const [, id, after] = m;
    if (htmlIds.has(id) || created.has(id) || after.includes("?.")) continue;
    const line = s.slice(0, m.index).split("\n").length;
    problems.push(`${f}:${line}: binds #${id} unguarded, but no such id exists`);
  }
}

// ── 3. called functions are defined ───────────────────────────────────
const GLOBALS = new Set([
  "if","for","while","switch","catch","return","typeof","function","await","import",
  "Number","String","Boolean","Array","Object","JSON","Math","Date","URL","Error","Promise",
  "URLSearchParams","CustomEvent","HashChangeEvent","FormData","Set","Map","RegExp",
  "setTimeout","clearTimeout","setInterval","clearInterval","parseInt","parseFloat","fetch",
  "isNaN","alert","confirm","encodeURIComponent","decodeURIComponent","btoa","atob","structuredClone",
  "matchMedia","requestAnimationFrame","getComputedStyle",
  "void","new","delete","throw","else","do","try","in","of","instanceof","async",
]);
for (const f of files) {
  const s = code(f);
  const defined = new Set([
    ...s.matchAll(new RegExp(String.raw`(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(${ID})`, "g")),
    ...s.matchAll(new RegExp(String.raw`(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(${ID})\s*=`, "g")),
    ...s.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${ID})\s*=`, "g")),
    // for (const x of ...) / for (const x in ...)
    ...s.matchAll(new RegExp(String.raw`for\s*\(\s*(?:const|let|var)\s+(${ID})\s+(?:of|in)\b`, "g")),
    // catch (err), and destructured bindings
    ...s.matchAll(new RegExp(String.raw`catch\s*\(\s*(${ID})`, "g")),
    ...s.matchAll(new RegExp(String.raw`(${ID})\s*(?::|=)\s*(?:async\s*)?\(`, "g")),
    ...s.matchAll(new RegExp(String.raw`function\s+(${ID})`, "g")),
  ].map((m) => m[1]).filter(Boolean));
  // const { a, b: c } = ... binds a and c
  for (const m of s.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(":").pop()?.split("=")[0]?.trim();
      if (n) defined.add(n);
    }
  }
  // every parameter list contributes names
  for (const m of s.matchAll(/(?:function[^(]*|=>\s*)?\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const p of m[1].split(",")) {
      // a nested opening paren can ride along on the first name
      // a destructured parameter ({ a, b }) starts with its brace
      const n = p.trim().replace(/^[{\[\s]+/, "").split(/[=:\s}\]]/)[0]?.replace(/^[^A-Za-z_$]+/, "");
      if (n) defined.add(n);
    }
  }
  // parameters count as defined
  for (const m of s.matchAll(new RegExp(String.raw`\(([^)]*)\)\s*=>`, "g"))) {
    for (const p of m[1].split(",")) defined.add(p.trim().split(/[=:\s]/)[0]);
  }
  const imported = new Set();
  for (const m of s.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(" as ").pop()?.trim();
      if (n) imported.add(n);
    }
  }
  for (const m of s.matchAll(/import\s+\*\s+as\s+(\w+)/g)) imported.add(m[1]);

  for (const m of s.matchAll(new RegExp(String.raw`(?<![\w.$])(${ID})\s*\(`, "g"))) {
    const name = m[1];
    if (defined.has(name) || imported.has(name) || GLOBALS.has(name)) continue;
    if (/^[A-Z]/.test(name)) continue;
    const line = s.slice(0, m.index).split("\n").length;
    problems.push(`${f}:${line}: calls ${name}() which is not defined or imported`);
  }
}

// ── 4. imports are actually used ──────────────────────────────────────
for (const f of files) {
  const s = code(f);
  // The import statements themselves must not count as usage. Matching
  // runs to the semicolon rather than to a quote, because stripNonCode has
  // already blanked the quote characters around the module path.
  const body = s
    .replace(/import\s*\{[^}]*\}\s*from[^;\n]*;?/g, "")
    .replace(/import\s+\*\s+as\s+\w+\s+from[^;\n]*;?/g, "");
  const names = [];
  for (const m of s.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(" as ").pop()?.trim();
      if (n) names.push(n);
    }
  }
  for (const m of s.matchAll(/import\s+\*\s+as\s+(\w+)/g)) names.push(m[1]);
  for (const n of names) {
    if (!new RegExp(String.raw`(?<![\w$])${n.replace(/\$/g, "\\$")}(?![\w$])`).test(body)) {
      problems.push(`${f}: imports '${n}' but never uses it`);
    }
  }
}

// ── 5. every id in index.html is used ─────────────────────────────────
// The reverse of check 2: markup nothing reaches is dead. An error toast
// once sat in index.html for months with no code left that could show it.
{
  const jsText = files.map(read).join("\n");
  const cssText = readFileSync(join(DIR, "styles.css"), "utf8");
  const htmlRefs = html.replace(/\sid="[^"]+"/g, "");
  for (const id of htmlIds) {
    const quoted = new RegExp(String.raw`["'\x60]${id}["'\x60]`);
    const hashed = new RegExp(String.raw`#${id}(?![\w-])`);
    if (hashed.test(jsText) || quoted.test(jsText) || hashed.test(cssText)) continue;
    // label for=, aria-controls= and the like inside index.html itself
    if (new RegExp(String.raw`="${id}"`).test(htmlRefs)) continue;
    problems.push(`index.html: #${id} is never referenced from JS, CSS or the page`);
  }
}

// ── 6. every module parses ────────────────────────────────────────────
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", join(DIR, f)], { stdio: "pipe" });
  } catch (err) {
    const msg = String(err.stderr).split("\n").find((l) => /Error/.test(l)) ?? "does not parse";
    problems.push(`${f}: ${msg.trim()}`);
  }
}

if (problems.length) {
  console.error("frontend check failed:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log(`frontend check passed (${files.length} modules)`);
