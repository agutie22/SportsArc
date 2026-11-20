/**
 * Highlight video. Recognises YouTube, Vimeo and Hudl links and renders
 * them "lite": a thumbnail and play button that only becomes an iframe
 * when tapped, so a profile with five highlights does not load five
 * players. YouTube plays from youtube-nocookie.com.
 *
 * Hudl has no public embed or thumbnail URL we can rely on, so it renders
 * as a branded card that opens Hudl.
 */

import { ICON, openSheet } from "./shared.js";
import { esc } from "./api.js";

export function videoInfo(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");

  let yt = null;
  if (host === "youtu.be") yt = u.pathname.slice(1);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    yt = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] ?? null;
  }
  if (yt && /^[\w-]{6,20}$/.test(yt)) {
    return {
      provider: "youtube",
      url: raw,
      thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
      embed: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&playsinline=1&rel=0`,
    };
  }

  const vimeo = host === "vimeo.com" ? u.pathname.match(/^\/(\d{5,12})/)?.[1] : null;
  if (vimeo) {
    return { provider: "vimeo", url: raw, thumb: null, embed: `https://player.vimeo.com/video/${vimeo}?autoplay=1` };
  }

  if (host === "hudl.com" || host.endsWith(".hudl.com")) {
    return { provider: "hudl", url: raw, thumb: null, embed: null };
  }
  return null;
}

/** First video link in a block of text, if any. */
export function firstVideoIn(text) {
  for (const m of String(text ?? "").matchAll(/https?:\/\/\S+/g)) {
    const v = videoInfo(m[0].replace(/[).,!?>]+$/, ""));
    if (v && v.embed) return v;
  }
  return null;
}

const LABEL = { youtube: "YouTube", vimeo: "Vimeo", hudl: "Hudl" };

/** A 16:9 lite player, or a Hudl card. */
export function liteVideo(v, { title = "" } = {}) {
  if (!v.embed) {
    return `
      <a class="video-card" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer nofollow">
        <span class="video-card-brand">${ICON.play}</span>
        <span><strong>${esc(title || "Watch on Hudl")}</strong><span>hudl.com</span></span>
        ${ICON.arrowRight}
      </a>`;
  }
  return `
    <div class="video-lite" data-embed="${esc(v.embed)}" role="button" tabindex="0"
         aria-label="Play ${esc(title || "video")}">
      ${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" decoding="async">` : ""}
      <span class="video-play">${ICON.play}</span>
      <span class="video-provider">${esc(LABEL[v.provider])}</span>
      ${title ? `<span class="video-title">${esc(title)}</span>` : ""}
    </div>`;
}

function play(el) {
  if (el.querySelector("iframe")) return;
  const frame = document.createElement("iframe");
  frame.src = el.dataset.embed;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  frame.title = "Highlight video";
  el.innerHTML = "";
  el.appendChild(frame);
  el.classList.add("playing");
}

/** Delegated, so lists that re-render need no re-binding. */
export function bindVideos(root) {
  if (!root || root.dataset.videosBound) return;
  root.dataset.videosBound = "1";
  root.addEventListener("click", (e) => {
    const el = e.target.closest(".video-lite");
    if (el) { e.stopPropagation(); play(el); }
  });
  root.addEventListener("keydown", (e) => {
    const el = e.target.closest?.(".video-lite");
    if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); play(el); }
  });
}

export function openVideoSheet(v, title) {
  const { body } = openSheet({ id: "video-sheet", title: title || "Highlight", className: "sheet-video" });
  body.innerHTML = liteVideo(v, { title });
  const el = body.querySelector(".video-lite");
  if (el) play(el);
}
