/*
 * Detects YouTube's AI disclosure inside a video page's HTML.
 *
 * The label isn't on feed thumbnails. It lives in each video's page data
 * (ytInitialData) as a "How this was made" section:
 *
 *   "howThisWasMadeSectionViewModel":{ ... "bodyHeader":{"content":"Made with AI"} ... }
 *
 * Matching the JSON key rather than the visible text makes this work in every
 * language. If YouTube renames the key, MARKER is the one thing to update.
 */
(function (root) {
  "use strict";

  // The trailing ":{" matters: the bare key also appears in a list of
  // component names on the page, which must not count as a match.
  const MARKER = '"howThisWasMadeSectionViewModel":{';

  // Help articles that the AI disclosure links to ("Learn more").
  //   15447836 = Understanding "How this content was made" disclosures
  // Seen and deliberately NOT listed: 15569972 = auto-dubbing.
  const AI_ARTICLES = ["15447836"];
  const ARTICLE_RE = /support\.google\.com\\?\/youtube\\?\/answer\\?\/(\d+)/g;

  const HEADER_RE = /"bodyHeader":\{"content":"((?:[^"\\]|\\.)*)"/;
  // English-only text checks, used as a guard and as a fallback:
  const NOT_AI_HEADER = /camera|dubbed/i; // "Captured with a camera", "Auto-dubbed"
  const AI_HEADER = /\bAI\b|altered|synthetic/i; // "Made with AI", "Altered or synthetic content"

  /** Returns the JSON object starting at text[start] === "{", or null if it does not close within limit. */
  function objectAt(text, start, limit) {
    const stop = Math.min(text.length, start + limit);
    let depth = 0;
    let inString = false;
    for (let i = start; i < stop; i++) {
      const c = text.charCodeAt(i);
      if (inString) {
        if (c === 92)
          i++; // backslash: skip the escaped character
        else if (c === 34) inString = false;
      } else if (c === 34) inString = true;
      else if (c === 123) depth++;
      else if (c === 125 && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  /** Is this "How this was made" section the AI disclosure? */
  function sectionIsAi(section) {
    const header = HEADER_RE.exec(section);
    const title = header ? header[1] : "";
    if (NOT_AI_HEADER.test(title)) return false;
    const articles = Array.from(section.matchAll(ARTICLE_RE), (m) => m[1]);
    if (articles.some((a) => AI_ARTICLES.includes(a))) return true;
    if (articles.length) return false; // links to some other disclosure's article
    return AI_HEADER.test(title); // no link at all: fall back to the English wording
  }

  const DATA_START = "var ytInitialData";
  const DATA_HINT = "ytInitialData";
  const SCRIPT_END = "</script>";
  const LOOKAHEAD = 8000; // characters after the marker needed to read the header

  /**
   * Incremental scanner. Feed it text as it downloads; only a short tail is
   * kept between chunks, so memory stays flat however large the page.
   * push()/end() return: true (AI label found), false (video page, no label),
   * undefined (not a video page), or null (need more data).
   */
  function createScanner() {
    const KEEP =
      Math.max(MARKER.length, DATA_START.length, SCRIPT_END.length) - 1;
    let tail = ""; // unprocessed end of the previous chunk
    let base = 0; // absolute offset of tail[0] in the document
    let dataAt = -1; // absolute offset of "var ytInitialData"
    let judgedUpTo = 0; // markers before this absolute offset are already judged
    let sawData = false;

    function step(chunk, final) {
      const text = tail + chunk;
      if (!sawData && text.includes(DATA_HINT)) sawData = true;
      if (dataAt === -1) {
        const i = text.indexOf(DATA_START);
        if (i !== -1) dataAt = base + i;
      }
      // The label always sits inside the ytInitialData script, so once that
      // script has closed without a match we can stop downloading.
      const dataEnd =
        dataAt === -1
          ? -1
          : text.indexOf(SCRIPT_END, Math.max(0, dataAt - base));

      let keepFrom = Math.max(0, text.length - KEEP);
      let waiting = false;
      let from = Math.max(0, judgedUpTo - base);
      for (;;) {
        const i = text.indexOf(MARKER, from);
        if (i === -1 || (dataEnd !== -1 && i > dataEnd)) break;
        const open = i + MARKER.length - 1;
        let section = objectAt(text, open, LOOKAHEAD);
        if (section === null) {
          if (!final && text.length < open + LOOKAHEAD) {
            keepFrom = Math.min(keepFrom, i); // hold on to it until the rest arrives
            waiting = true;
            break;
          }
          section = text.slice(open, open + LOOKAHEAD);
        }
        if (sectionIsAi(section)) return true;
        from = i + MARKER.length;
        judgedUpTo = base + from;
      }

      if (!waiting && dataEnd !== -1) return false;
      if (final) return sawData ? false : undefined;
      tail = text.slice(keepFrom);
      base += keepFrom;
      return null;
    }

    return {
      push: (text) => step(text, false),
      end: () => step("", true),
    };
  }

  function scanAll(scanner, text) {
    const result = scanner.push(text);
    return result === null ? scanner.end() : result;
  }

  /** Whole-string version, handy for tests. */
  const htmlHasAiLabel = (html) => scanAll(createScanner(), html);

  /** Reads a fetch Response as a stream and stops as soon as the answer is known. */
  async function readResponse(res) {
    const scanner = createScanner();
    if (!res.body) return scanAll(scanner, await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const result = scanner.push(decoder.decode(value, { stream: true }));
      if (result !== null) {
        reader.cancel().catch(() => {});
        return result;
      }
    }
    return scanner.end();
  }

  const api = { MARKER, createScanner, htmlHasAiLabel, readResponse };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AIF_DETECT = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
