/**
 * The post composer. One implementation serves the inline box at the top
 * of Home on desktop and the full-screen sheet phones open from the
 * bottom bar, so text limits and image handling cannot drift apart.
 *
 * A successful post fires "sportsarc:posted" on document; whatever list
 * is on screen decides for itself whether to refresh.
 */

import { getUser, toast, ICON, openSheet } from "./shared.js";
import { apiSend, esc, avatar, uploadImage } from "./api.js";

const MAX_LEN = 500;
const MAX_IMAGES = 4;
const RING_R = 10;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Render a composer into `root`. Returns a focus() helper.
 *
 * `sport` tags the post for that sport's page. `market` shares a Pro market
 * ({ symbol, outcome, title, label }): it shows as a chip the author can
 * remove, and only the symbol and side are sent; the server fills in the
 * rest from Gemini.
 */
export function mountComposer(root, { autofocus = false, onPosted, sport = null, market = null, placeholder } = {}) {
  const user = getUser();
  if (!root || !user) return { focus() {} };

  root.innerHTML = `
    <div class="composer">
      ${avatar(user, "sm")}
      <div class="composer-body">
        <textarea class="composer-input" rows="1" maxlength="${MAX_LEN}"
          placeholder="${esc(placeholder ?? (market ? "Say why you took it" : "What's happening in your game?"))}" aria-label="Post text"></textarea>
        ${market ? `
          <div class="composer-market">
            <span class="composer-market-text"><strong>${esc(market.label)}</strong> · ${esc(market.title)}</span>
            <button type="button" class="composer-market-x" aria-label="Remove market">&times;</button>
          </div>` : ""}
        <div class="composer-media"></div>
        <div class="composer-foot">
          <label class="icon-btn composer-tool" title="Add photos">
            ${ICON.image}<span class="sr-only">Add photos</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
          </label>
          <a class="icon-btn composer-tool" href="#/games" title="Host a game">${ICON.ball}<span class="sr-only">Host a game</span></a>
          <span class="composer-spacer"></span>
          <span class="composer-count" hidden></span>
          <svg class="composer-ring" viewBox="0 0 26 26" hidden>
            <circle class="track" cx="13" cy="13" r="${RING_R}"/>
            <circle class="bar" cx="13" cy="13" r="${RING_R}"
              stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/>
          </svg>
          <button class="btn-post" disabled>Post</button>
        </div>
      </div>
    </div>`;

  const box = root.querySelector(".composer");
  const input = root.querySelector(".composer-input");
  const media = root.querySelector(".composer-media");
  const file = root.querySelector('input[type="file"]');
  const ring = root.querySelector(".composer-ring");
  const bar = ring.querySelector(".bar");
  const count = root.querySelector(".composer-count");
  const btn = root.querySelector(".btn-post");

  /** @type {{ id: number, url: string|null, preview: string }[]} */
  let images = [];
  let seq = 0;
  let shared = market;

  root.querySelector(".composer-market-x")?.addEventListener("click", () => {
    shared = null;
    root.querySelector(".composer-market")?.remove();
    sync();
  });

  const uploading = () => images.some((i) => !i.url);

  function sync() {
    const len = input.value.length;
    const text = input.value.trim();
    btn.disabled = uploading() || (!text && images.length === 0 && !shared);
    box.classList.toggle("is-active", len > 0 || images.length > 0 || document.activeElement === input);

    ring.toggleAttribute("hidden", len === 0);
    const left = MAX_LEN - len;
    bar.setAttribute("stroke-dashoffset", String(RING_C * (1 - Math.min(len / MAX_LEN, 1))));
    ring.classList.toggle("warn", left <= 50 && left > 0);
    ring.classList.toggle("over", left <= 0);
    count.hidden = left > 50;
    count.textContent = String(left);
    count.classList.toggle("composer-count-low", left <= 50);

    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function paintMedia() {
    media.innerHTML = images.map((i) => `
      <div class="composer-thumb${i.url ? "" : " uploading"}" data-id="${i.id}">
        <img src="${esc(i.preview)}" alt="">
        <button type="button" class="composer-thumb-x" aria-label="Remove image">&times;</button>
      </div>`).join("");
    sync();
  }

  media.addEventListener("click", (e) => {
    const x = e.target.closest(".composer-thumb-x");
    if (!x) return;
    const id = Number(x.closest("[data-id]").dataset.id);
    const gone = images.find((i) => i.id === id);
    if (gone) URL.revokeObjectURL(gone.preview);
    images = images.filter((i) => i.id !== id);
    paintMedia();
  });

  file.addEventListener("change", async () => {
    const picked = [...file.files].slice(0, MAX_IMAGES - images.length);
    if (file.files.length > picked.length) toast(`Up to ${MAX_IMAGES} images per post.`);
    file.value = "";
    const batch = picked.map((f) => ({ id: ++seq, url: null, preview: URL.createObjectURL(f), f }));
    images.push(...batch);
    paintMedia();
    await Promise.all(batch.map(async (item) => {
      try {
        item.url = await uploadImage(item.f);
      } catch (err) {
        toast(err.message);
        URL.revokeObjectURL(item.preview);
        images = images.filter((i) => i !== item);
      }
    }));
    paintMedia();
  });

  input.addEventListener("input", sync);
  input.addEventListener("focus", sync);
  input.addEventListener("blur", sync);
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !btn.disabled) void submit();
  });
  btn.addEventListener("click", () => void submit());

  async function submit() {
    const text = input.value.trim();
    if (uploading() || (!text && images.length === 0 && !shared)) return;
    // A shared market with nothing typed still says something.
    const body = text || (shared ? `Took ${shared.label}` : "");
    btn.disabled = true;
    try {
      await apiSend("/api/posts", "POST", {
        body,
        images: images.map((i) => i.url),
        ...(sport ? { sport } : {}),
        ...(shared ? { market: { symbol: shared.symbol, outcome: shared.outcome } } : {}),
      });
      shared = null;
      root.querySelector(".composer-market")?.remove();
      images.forEach((i) => URL.revokeObjectURL(i.preview));
      images = [];
      input.value = "";
      paintMedia();
      input.blur();
      toast("Posted");
      document.dispatchEvent(new CustomEvent("sportsarc:posted"));
      onPosted?.();
    } catch (err) {
      toast(err.message);
      sync();
    }
  }

  sync();
  if (autofocus) setTimeout(() => input.focus(), 60);
  return { focus: () => input.focus() };
}

/** Full-screen on phones, a centred dialog on desktop. Options as mountComposer's. */
export function openComposeSheet({ sport = null, market = null } = {}) {
  if (document.getElementById("compose-sheet")) return;
  const { body, close } = openSheet({ id: "compose-sheet", title: market ? "Share your pick" : "New post" });
  body.style.padding = "0";
  mountComposer(body, { autofocus: true, onPosted: close, sport, market });
}
