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
    maxConcurrent: 6, // each lookup takes ~1s, mostly YouTube's server time
    lookAhead: "800px 0px", // cards this far outside the viewport are checked first
    scanDelay: 200,
    recheckDays: 7, // unlabeled videos only; YouTube can add a label later
    maxCached: 10000, // 11 bytes each, so storage stays around 110 KB
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

  const verdicts = new Map(); // videoId -> true (labeled) | false, oldest first
  const paths = new Map(); // videoId -> same-origin path to fetch
  const attempts = new Map(); // videoId -> failed lookups
  const visible = new WeakSet(); // cards near the viewport
  let scannedHref = new WeakMap(); // link -> href it had when last scanned
  const queue = []; // videoIds near the viewport; newest is taken first
  const backlog = []; // videoIds further away; top of the page is taken first
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

  // Labeled answers are kept for good. Unlabeled ones are checked again after
  // CFG.recheckDays, since YouTube can add the label later. In memory each
  // video maps to true (labeled) or the day it was found unlabeled. Storage
  // holds back-to-back 11-character ids, oldest first:
  //   { ai: "id1id2…", ok: { "<day>": "id3id4…", … } }
  const today = () => Math.floor(Date.now() / DAY);
  const isFresh = (v) => v === true || today() - v < CFG.recheckDays;
  const stateOf = (ai) => (ai ? "ai" : "ok");

  /** true (labeled), false (not labeled), or undefined (unchecked or due a re-check). */
  function known(id) {
    const v = verdicts.get(id);
    return v !== undefined && isFresh(v) ? v === true : undefined;
  }

  function* idsIn(ids) {
    for (let i = 0; i + 11 <= ids.length; i += 11) yield ids.slice(i, i + 11);
  }

  /** Stored verdicts as [id, value] pairs, oldest first. */
  function decode(stored) {
    if (!stored) return [];
    if (typeof stored.ai === "string") {
      const out = [];
      // Integer keys come out in ascending order, so oldest day first.
      if (stored.ok && typeof stored.ok === "object")
        for (const [day, ids] of Object.entries(stored.ok))
          for (const id of idsIn(ids)) out.push([id, +day]);
      for (const id of idsIn(stored.ai)) out.push([id, true]);
      return out;
    }
    // Format used up to 1.1.2: { id: [ai, checkedAt] }
    return Object.entries(stored)
      .filter(([, e]) => Array.isArray(e))
      .sort((a, b) => a[1][1] - b[1][1])
      .map(([id, [ai, t]]) => [id, ai ? true : Math.floor(t / DAY)]);
  }

  // A label beats no label, and a later check beats an earlier one.
  const isNewer = (a, b) =>
    b === undefined || (a !== b && (a === true || (b !== true && a > b)));

  function remember(id, v) {
    verdicts.delete(id); // re-insert so the map stays oldest first
    verdicts.set(id, v);
  }

  /** Returns how many verdicts were new or newer than ours. */
  function merge(stored) {
    let changed = 0;
    for (const [id, v] of decode(stored)) {
      if (!isNewer(v, verdicts.get(id))) continue;
      remember(id, v);
      changed++;
    }
    return changed;
  }

  function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 1500);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    // Unlabeled answers due a re-check aren't worth keeping. Over the cap,
    // forget the oldest unlabeled ones next, since losing one only costs a
    // re-check, then the oldest labeled ones.
    for (const [id, v] of verdicts) if (!isFresh(v)) verdicts.delete(id);
    let excess = verdicts.size - CFG.maxCached;
    for (const labeled of [false, true]) {
      for (const [id, v] of verdicts) {
        if (excess <= 0) break;
        if ((v === true) !== labeled) continue;
        verdicts.delete(id);
        excess--;
      }
    }
    let ai = "";
    const ok = {};
    for (const [id, v] of verdicts) {
      if (v === true) ai += id;
      else ok[v] = (ok[v] || "") + id;
    }
    safeChrome(() => chrome.storage.local.set({ verdicts: { ai, ok } }));
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
        if (card.dataset.aif === "pending") enqueue(card.dataset.aifId, true);
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
    card.dataset.aif = v === undefined ? "pending" : stateOf(v);
    if (v === undefined) enqueue(id, visible.has(card));
  }

  function paint(id) {
    const v = known(id);
    if (v === undefined) return;
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
    if (v === undefined) {
      banner(null);
      rememberPath(cur);
      wanted.add(cur.id);
      enqueue(cur.id, true);
      return;
    }
    if (cur.kind !== "shorts" || !v) return banner(null);
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

  // Every card is looked up as soon as it appears, so most are answered
  // before they scroll into view. Cards near the viewport (soon) go in
  // `queue` and are taken newest first; the rest wait in `backlog` and are
  // taken top of the page first, whenever nothing nearer is waiting.
  function enqueue(id, soon) {
    if (!id) return;
    if (queued.has(id)) {
      if (!soon) return;
      // Already waiting: move it up once it nears the viewport, and move
      // the open video to the front.
      const b = backlog.indexOf(id);
      if (b !== -1) {
        backlog.splice(b, 1);
        queue.push(id);
        return;
      }
      const at = wanted.has(id) ? queue.indexOf(id) : -1;
      if (at !== -1) queue.push(queue.splice(at, 1)[0]);
      return;
    }
    if ((attempts.get(id) || 0) >= CFG.maxAttempts) return;
    queued.add(id);
    (soon ? queue : backlog).push(id);
    pump();
  }

  function pump() {
    if (!settings.enabled || !alive || Date.now() < pausedUntil) return;
    while (active < CFG.maxConcurrent && (queue.length || backlog.length)) {
      const id = queue.length ? queue.pop() : backlog.shift();
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
      remember(id, verdict || today());
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
      enqueue(card.dataset.aifId, visible.has(card));
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
    const label =
      v === undefined
        ? queued.has(cur.id)
          ? "checking"
          : "unknown"
        : v
          ? "labeled"
          : "not labeled";
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
        waiting: queue.length + backlog.length,
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
        // "Clear saved results" was pressed in the popup.
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
      if (got.rules === RULES) {
        merge(got.verdicts);
        // Rewrite answers saved in the old, larger format.
        if (got.verdicts && typeof got.verdicts.ai !== "string") saveNow();
      } else {
        chrome.storage.local.set({ rules: RULES, verdicts: { ai: "", ok: {} } });
      }
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

  // Only inserted elements and href changes can bring in video links. The
  // player rewrites its time display and captions many times a second while
  // a video plays, so ignore text-only changes and anything inside it.
  function onMutations(records) {
    if (scanTimer) return;
    for (const r of records) {
      if (r.type === "attributes") return scheduleScan();
      if (!hasElement(r.addedNodes)) continue;
      if (r.target.closest?.(".html5-video-player")) continue;
      return scheduleScan();
    }
  }

  function hasElement(nodes) {
    for (const n of nodes) if (n.nodeType === 1) return true;
    return false;
  }

  // YouTube is a single-page app with infinite scroll: watch for new cards and
  // for recycled cards whose links change.
  new MutationObserver(onMutations).observe(document, {
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
