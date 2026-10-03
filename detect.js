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
  'use strict';

  // The trailing ":{" matters: the bare key also appears in a list of
  // component names on the page, which must not count as a match.
  const MARKER = '"howThisWasMadeSectionViewModel":{';

  // The same section can carry a rare non-AI disclosure ("Captured with a
  // camera"). This guard only recognises the English wording.
  const NOT_AI_HEADER = /camera/i;
  const HEADER_RE = /"bodyHeader":\{"content":"((?:[^"\\]|\\.)*)"/;

  const DATA_START = 'var ytInitialData';
  const DATA_HINT = 'ytInitialData';
  const SCRIPT_END = '</script>';
  const LOOKAHEAD = 6000; // characters after the marker needed to read the header

  /**
   * Incremental scanner. Feed it text as it downloads; only a short tail is
   * kept between chunks, so memory stays flat however large the page.
   * push()/end() return: true (AI label found), false (video page, no label),
   * undefined (not a video page), or null (need more data).
   */
  function createScanner() {
    const KEEP = Math.max(MARKER.length, DATA_START.length, SCRIPT_END.length) - 1;
    let tail = ''; // unprocessed end of the previous chunk
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
      const dataEnd = dataAt === -1 ? -1 : text.indexOf(SCRIPT_END, Math.max(0, dataAt - base));

      let keepFrom = Math.max(0, text.length - KEEP);
      let waiting = false;
      let from = Math.max(0, judgedUpTo - base);
      for (;;) {
        const i = text.indexOf(MARKER, from);
        if (i === -1 || (dataEnd !== -1 && i > dataEnd)) break;
        if (!final && text.length < i + LOOKAHEAD) {
          keepFrom = Math.min(keepFrom, i); // hold on to it until the header arrives
          waiting = true;
          break;
        }
        const header = HEADER_RE.exec(text.slice(i, i + LOOKAHEAD));
        if (!(header && NOT_AI_HEADER.test(header[1]))) return true;
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
      end: () => step('', true),
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
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIF_DETECT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
