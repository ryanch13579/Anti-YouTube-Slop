/*
 * Content script: finds video cards on YouTube pages, looks up whether each
 * video carries YouTube's AI label, remembers the answer, and hides the ones
 * that do. In the Shorts player it skips labeled Shorts instead.
 */
(() => {
  "use strict";
  if (window.top !== window) return;

  const detect = globalThis.AIF_DETECT;
  const DAY = 864e5;

  // ---- Everything YouTube-specific that may need updating lives here -------
  const CFG = {
    links: 'a[href*="/watch?v="], a[href*="/shorts/"]',
    // Outer containers are tried first so the whole grid cell disappears;
    // inner ones are the fallback.
    outerCards: [
      "ytd-rich-item-renderer", // home, subscriptions, channel grids, Shorts shelves
      "ytd-video-renderer", // search results
      "ytd-compact-video-renderer", // watch-page sidebar (older layout)
      "ytd-grid-video-renderer", // channel grids (older layout)
      "ytd-reel-item-renderer", // Shorts shelves (older layout)
    ].join(","),
    innerCards: [
      "yt-lockup-view-model", // watch-page sidebar and newer grids
      "ytm-shorts-lockup-view-model-v2",
      "ytm-shorts-lockup-view-model",
    ].join(","),
    shortsNext:
      '#navigation-button-down button, button[aria-label="Next video"]',
    maxConcurrent: 3,
    lookAhead: "800px 0px", // start checking this far outside the viewport
    scanDelay: 200,
    aiTtl: 90 * DAY,
    cleanTtl: 7 * DAY, // labels can be added later, so re-check weekly
    maxCached: 8000,
    maxAttempts: 3,
    skipDelay: 1200,
    maxSkipTries: 3,
  };
  // --------------------------------------------------------------------------

  const DEFAULTS = { enabled: true, mode: "hide" }; // mode: 'hide' | 'dim'
  const ID_RE = /^[\w-]{11}$/;
  const html = document.documentElement;
  // Bump whenever detect.js changes what counts as labeled.
  const RULES = 2;

  let settings = { ...DEFAULTS };
  let alive = true; // false once the extension is reloaded or removed

  const verdicts = new Map(); // videoId -> { ai, t }
  const paths = new Map(); // videoId -> same-origin path to fetch
  const attempts = new Map(); // videoId -> failed lookups
  const visible = new WeakSet(); // cards near the viewport
  let scannedHref = new WeakMap(); // link -> href it had when last scanned
  const queue = []; // videoIds waiting; newest is taken first
  const queued = new Set(); // waiting or in flight
  const wanted = new Set(); // ids to look up without a card (the open video)
  const stats = {
    answered: 0,
    failed: 0,
    lastError: "",
    skipClicks: 0,
    skipKeys: 0,
    skipStuck: 0,
  };

  let active = 0;
  let pausedUntil = 0;
  let failures = 0;
  let scanTimer = 0;
  let saveTimer = 0;
  let skipping = { id: "", tries: 0, at: 0, stuck: false };
  let bannerEl = null;

  // ---- Settings -------------------------------------------------------------

  const withDefaults = (stored) => ({ ...DEFAULTS, ...stored });

  function applyMode() {
    html.classList.toggle(
      "aif-hide",
      settings.enabled && settings.mode === "hide",
    );
    html.classList.toggle(
      "aif-dim",
      settings.enabled && settings.mode === "dim",
    );
  }
  applyMode(); // hide by default before settings have loaded

  // chrome.* calls throw once the extension has been reloaded; go quiet then.
  function safeChrome(fn) {
    if (!alive) return Promise.resolve();
    try {
      return Promise.resolve(fn()).catch(() => {});
    } catch {
      alive = false;
      return Promise.resolve();
    }
  }

  // ---- Verdict cache --------------------------------------------------------

  const isFresh = (v) => Date.now() - v.t < (v.ai ? CFG.aiTtl : CFG.cleanTtl);
  const stateOf = (v) => (v.ai ? "ai" : "ok");

  function known(id) {
    const v = verdicts.get(id);
    return v && isFresh(v) ? v : null;
  }

  /** Returns how many verdicts were new or newer than ours. */
  function merge(stored) {
    let changed = 0;
    for (const [id, entry] of Object.entries(stored || {})) {
      if (!Array.isArray(entry)) continue;
      const [ai, t] = entry;
      const cur = verdicts.get(id);
      if (!cur || cur.t < t) {
        verdicts.set(id, { ai: !!ai, t });
        changed++;
      }
    }
    return changed;
  }

  function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 1500);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    let newest = [...verdicts].filter(([, v]) => isFresh(v));
    if (newest.length > CFG.maxCached)
      newest = newest.sort((a, b) => b[1].t - a[1].t).slice(0, CFG.maxCached);
    const out = Object.fromEntries(
      newest.map(([id, v]) => [id, [v.ai ? 1 : 0, v.t]]),
    );
    safeChrome(() => chrome.storage.local.set({ verdicts: out }));
  }

  // ---- Video URLs -----------------------------------------------------------

  function videoRef(url) {
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return id && ID_RE.test(id)
        ? { id, kind: "watch", path: "/watch?v=" + id }
        : null;
    }
    const m = /^\/shorts\/([\w-]{11})(?:\/|$)/.exec(url.pathname);
    return m ? { id: m[1], kind: "shorts", path: "/shorts/" + m[1] } : null;
  }

  function parseVideoLink(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (url.hostname !== location.hostname) return null;
    if (url.pathname === "/watch" && url.searchParams.has("list")) return null; // playlists and mixes
    return videoRef(url);
  }

  const openVideo = () => videoRef(new URL(location.href));

  function rememberPath(ref) {
    if (!paths.has(ref.id)) paths.set(ref.id, ref.path);
  }

  // ---- Cards ----------------------------------------------------------------

  const cardFor = (link) =>
    link.closest(CFG.outerCards) || link.closest(CFG.innerCards);
  const pendingCards = () => document.querySelectorAll('[data-aif="pending"]');

  const viewport = new IntersectionObserver(
    (entries) => {
      for (const { target: card, isIntersecting } of entries) {
        if (!isIntersecting) {
          visible.delete(card);
          continue;
        }
        visible.add(card);
        if (card.dataset.aif === "pending") enqueue(card.dataset.aifId);
      }
    },
    { rootMargin: CFG.lookAhead },
  );

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, CFG.scanDelay);
  }

  function scan() {
    scanTimer = 0;
    if (!settings.enabled || !alive) return;
    const seen = new Set();
    for (const link of document.querySelectorAll(CFG.links)) {
      // Scans run several times a second while YouTube is busy; skip links
      // that haven't changed since last time instead of re-parsing them all.
      const href = link.getAttribute("href");
      if (scannedHref.get(link) === href) continue;
      const card = cardFor(link);
      if (!card) continue; // not in a card yet; look again next scan
      scannedHref.set(link, href);
      if (seen.has(card)) continue;
      const ref = parseVideoLink(href);
      if (!ref) continue;
      seen.add(card);
      // YouTube recycles card elements for different videos, so re-read the
      // id on every scan and reset the card when it changes.
      if (card.dataset.aifId === ref.id) continue;
      card.dataset.aifId = ref.id;
      rememberPath(ref);
      viewport.observe(card);
      resolve(card, ref.id);
    }
    checkOpenVideo();
  }

  function resolve(card, id) {
    const v = known(id);
    card.dataset.aif = v ? stateOf(v) : "pending";
    if (!v && visible.has(card)) enqueue(id);
  }

  function paint(id) {
    const v = verdicts.get(id);
    if (!v) return;
    for (const card of document.querySelectorAll(`[data-aif-id="${id}"]`))
      card.dataset.aif = stateOf(v);
  }

  function resetCards() {
    scannedHref = new WeakMap();
    for (const card of document.querySelectorAll("[data-aif-id]")) {
      delete card.dataset.aifId;
      delete card.dataset.aif;
    }
  }

  // ---- The video that is open right now -------------------------------------

  // A watch page is only reported in the popup. In the Shorts player a labeled
  // Short is skipped, since Shorts there are fed one after another rather than
  // chosen from thumbnails.
  function checkOpenVideo() {
    const cur = openVideo();
    if (!cur || !settings.enabled) return banner(null);
    const v = known(cur.id);
    if (!v) {
      banner(null);
      rememberPath(cur);
      wanted.add(cur.id);
      enqueue(cur.id);
      return;
    }
    if (cur.kind !== "shorts" || !v.ai) return banner(null);
    if (settings.mode === "dim")
      return banner("AI-labeled Short – would be skipped");
    skipShort(cur.id);
  }

  function skipShort(id) {
    const now = Date.now();
    if (skipping.id !== id) skipping = { id, tries: 0, at: 0, stuck: false };
    if (skipping.stuck || now - skipping.at < CFG.skipDelay) return;
    if (skipping.tries >= CFG.maxSkipTries) {
      skipping.stuck = true;
      stats.skipStuck++;
      banner("AI-labeled Short – could not skip automatically");
      return;
    }
    skipping.at = now;
    skipping.tries++;

    const next = document.querySelector(CFG.shortsNext);
    if (next) {
      stats.skipClicks++;
      next.click();
    } else {
      // No arrow button: fall back to the keyboard shortcut.
      stats.skipKeys++;
      const init = {
        key: "ArrowDown",
        code: "ArrowDown",
        keyCode: 40,
        which: 40,
        bubbles: true,
        cancelable: true,
      };
      (document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", init),
      );
    }
    setTimeout(checkOpenVideo, CFG.skipDelay + 100); // still on it? try again
  }

  function banner(text) {
    if (!text) {
      bannerEl?.remove();
      bannerEl = null;
      return;
    }
    bannerEl ??= Object.assign(document.createElement("div"), {
      id: "aif-banner",
    });
    if (bannerEl.textContent !== text) bannerEl.textContent = text;
    if (!bannerEl.isConnected && document.body) document.body.append(bannerEl);
  }

  // ---- Looking videos up ----------------------------------------------------

  function enqueue(id) {
    if (!id) return;
    if (queued.has(id)) {
      // Already waiting: move the open video to the front.
      const at = wanted.has(id) ? queue.indexOf(id) : -1;
      if (at !== -1) queue.push(queue.splice(at, 1)[0]);
      return;
    }
    if ((attempts.get(id) || 0) >= CFG.maxAttempts) return;
    queued.add(id);
    queue.push(id);
    pump();
  }

  function pump() {
    if (!settings.enabled || !alive || Date.now() < pausedUntil) return;
    while (active < CFG.maxConcurrent && queue.length) {
      const id = queue.pop();
      const stillNeeded =
        wanted.has(id) ||
        document.querySelector(`[data-aif-id="${id}"][data-aif="pending"]`);
      if (!stillNeeded) {
        queued.delete(id);
        continue;
      }
      active++;
      check(id).finally(() => {
        active--;
        queued.delete(id);
        pump();
      });
    }
  }

  // Resolves to { verdict, problem, backOff }. verdict is a boolean only when
  // the page gave a definite answer.
  async function lookup(id) {
    try {
      const res = await fetch(paths.get(id) || "/watch?v=" + id, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        return {
          problem: "HTTP " + res.status,
          backOff: res.status === 429 || res.status >= 500,
        };
      }
      const verdict = await detect.readResponse(res);
      return verdict === undefined
        ? { problem: "response was not a video page" }
        : { verdict };
    } catch (e) {
      // Offline, blocked, or redirected off-site.
      return { problem: "request failed: " + (e?.message || e), backOff: true };
    }
  }

  async function check(id) {
    const { verdict, problem, backOff } = await lookup(id);
    wanted.delete(id);

    if (typeof verdict === "boolean") {
      failures = 0;
      stats.answered++;
      attempts.delete(id);
      paths.delete(id);
      verdicts.set(id, { ai: verdict, t: Date.now() });
      paint(id);
      scheduleSave();
      checkOpenVideo();
      return;
    }

    // No answer: leave the card visible, never cache a guess, try again later.
    stats.failed++;
    stats.lastError = problem;
    attempts.set(id, (attempts.get(id) || 0) + 1);
    let wait = 60e3;
    if (backOff) {
      failures++;
      wait = Math.min(30e3 * 2 ** (failures - 1), 10 * 60e3);
      pausedUntil = Date.now() + wait;
    }
    setTimeout(retryPending, wait + 100);
  }

  function retryPending() {
    for (const card of pendingCards()) {
      if (visible.has(card)) enqueue(card.dataset.aifId);
    }
    checkOpenVideo();
    pump();
  }

  // ---- Status for the popup -------------------------------------------------

  function ancestry(el) {
    const chain = [];
    for (
      ;
      el && el !== document.body && chain.length < 9;
      el = el.parentElement
    ) {
      chain.push(el.localName + (el.id ? "#" + el.id : ""));
    }
    return chain.join(" < ");
  }

  function openVideoStatus() {
    const cur = openVideo();
    if (!cur) return null;
    const v = known(cur.id);
    const label = v
      ? v.ai
        ? "labeled"
        : "not labeled"
      : queued.has(cur.id)
        ? "checking"
        : "unknown";
    return { kind: cur.kind, id: cur.id, label };
  }

  function report() {
    const cards = new Set();
    const states = { ai: 0, ok: 0, pending: 0 };
    const cardTags = {};
    const strayExamples = [];
    let strayLinks = 0;

    for (const link of document.querySelectorAll(CFG.links)) {
      if (!parseVideoLink(link.getAttribute("href"))) continue;
      const card = cardFor(link);
      if (!card) {
        // A few stray links are normal; many means YouTube's card markup changed.
        strayLinks++;
        if (strayExamples.length < 4) {
          const chain = ancestry(link);
          if (!strayExamples.includes(chain)) strayExamples.push(chain);
        }
        continue;
      }
      if (cards.has(card)) continue;
      cards.add(card);
      cardTags[card.localName] = (cardTags[card.localName] || 0) + 1;
      if (card.dataset.aif in states) states[card.dataset.aif]++;
    }

    let version = "";
    try {
      version = chrome.runtime.getManifest().version;
    } catch {}

    return {
      version,
      page: location.pathname,
      enabled: settings.enabled,
      mode: settings.mode,
      cards: cards.size,
      states,
      cardTags,
      strayLinks,
      strayExamples,
      openVideo: openVideoStatus(),
      lookups: {
        answered: stats.answered,
        failed: stats.failed,
        lastError: stats.lastError,
        running: active,
        waiting: queue.length,
        pausedSeconds: Math.max(
          0,
          Math.round((pausedUntil - Date.now()) / 1000),
        ),
      },
      shorts: {
        nextButtonFound: !!document.querySelector(CFG.shortsNext),
        skipClicks: stats.skipClicks,
        skipKeys: stats.skipKeys,
        skipStuck: stats.skipStuck,
      },
      saved: verdicts.size,
    };
  }

  // ---- Start ----------------------------------------------------------------

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes.settings) {
      settings = withDefaults(changes.settings.newValue);
      applyMode();
      if (settings.enabled) {
        scan();
        retryPending();
      } else {
        banner(null);
      }
    }
    if (changes.verdicts) {
      if (changes.verdicts.newValue) {
        // Answers found in other tabs. Our own saves land here too and
        // change nothing, so skip the card pass for those.
        if (merge(changes.verdicts.newValue))
          for (const card of pendingCards()) resolve(card, card.dataset.aifId);
      } else {
        // "Reset" was pressed in the popup.
        verdicts.clear();
        attempts.clear();
        resetCards();
        scheduleScan();
      }
    }
  }

  safeChrome(() =>
    chrome.storage.local.get(["settings", "verdicts", "rules"]).then((got) => {
      settings = { ...DEFAULTS, ...(got.settings || {}) };
      // Answers saved under older detection rules are thrown away, not trusted.
      if (got.rules === RULES) merge(got.verdicts);
      else chrome.storage.local.set({ rules: RULES, verdicts: {} });
      applyMode();
      scan();
    }),
  );

  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type === "aif-report") reply(report());
    });
  } catch {
    alive = false;
  }

  // YouTube is a single-page app with infinite scroll: watch for new cards and
  // for recycled cards whose links change.
  new MutationObserver(scheduleScan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  window.addEventListener("yt-navigate-finish", scheduleScan);
  window.addEventListener("popstate", scheduleScan);
  document.addEventListener("DOMContentLoaded", scheduleScan);

  // Swiping through Shorts doesn't always touch the parts of the page we
  // observe, so also check the open video on a slow tick.
  setInterval(() => {
    if (settings.enabled && alive && openVideo()) checkOpenVideo();
  }, 1000);

  // Don't lose answers found just before leaving the page.
  window.addEventListener("pagehide", () => {
    if (saveTimer) saveNow();
  });
})();
