# Hide AI-Labeled Videos

A Chrome extension that hides YouTube videos labeled **"Made with AI"**.

It removes them from the home feed, subscriptions, search results, the
watch-page sidebar, channel pages and Shorts shelves, and skips them in the
Shorts player.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Version](https://img.shields.io/badge/version-1.1.4-green)

https://github.com/user-attachments/assets/72f0da9e-6c2a-4d9f-8953-27100d3670c0

## Features

- **Hide or dim**: remove labeled videos, or keep them visible with a red
  "AI-labeled" tag so you can see what the filter catches.
- **Shorts skipping**: labeled Shorts are skipped automatically.
- **Fast**: thumbnails are checked as soon as they load, so most answers are
  ready before you scroll to them.
- **Any language**: detection uses YouTube's page data, not the label's text.
- **Private**: no accounts, no analytics, no outside servers. See
  [Privacy](#privacy).

## Install

Install it from the Chrome Web Store, or load it from source:

1. Clone the repository, or download it as a ZIP and unzip it somewhere
   permanent:
   ```sh
   git clone https://github.com/ryanch13579/Anti-YouTube-Slop.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the project folder.
4. Open or refresh YouTube.

It should also work in other Chromium browsers (Edge, Brave, Opera, Vivaldi).

To update, run `git pull`, click the reload arrow on the extension's card in
`chrome://extensions`, then refresh your YouTube tabs.

## Usage

Click the toolbar icon to:

- turn the filter on or off
- choose **Hide** or **Dim and tag them**
- see how many videos have been checked and how many were labeled
- see whether the open video or Short has YouTube's label
- see warnings, such as YouTube refusing checks
- clear the cache with **Clear saved results**

## How it works

YouTube doesn't show the AI label on thumbnails, only on each video's own
page. So for each video card, the extension fetches that video's page in the
background, looks for the label and caches the answer.

Up to 6 checks run at once. Cards near the screen go first, then the rest of
the page from top to bottom. Labeled results are kept permanently; unlabeled
ones are re-checked after 7 days, since YouTube can add a label later.

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (MV3). |
| `detect.js` | Finds the label in a page's data by matching the JSON key `"howThisWasMadeSectionViewModel":{`. |
| `content.js` | Finds video cards, queues and caches checks, marks cards and skips labeled Shorts. |
| `content.css` | Hides or dims marked cards. |
| `popup.html` / `popup.js` | The toolbar popup. |
| `icons/` | Extension icons. |

## Limitations

- **Only YouTube's own label counts.** AI voiceovers, scripts and stylized or
  animated AI content are often unlabeled, so they aren't hidden.
- **First check can flash.** A video stays visible until its first check
  finishes. Most finish before the card scrolls into view, but on a fast
  scroll you may see one briefly. Cached videos are hidden immediately.
- **Rate limits.** If YouTube answers "too many requests", the extension
  pauses and retries later. Unchecked videos stay visible meanwhile.
- **Shorts.** A labeled Short may play for a moment the first time it comes
  up, before it is skipped.
- **Direct links still play.** A labeled long-form video opened directly still
  plays. Only its thumbnails are hidden.
- **Playlists and mixes** are not filtered.

## Troubleshooting

YouTube changes its page structure from time to time. If the extension stops
working:

- **Nothing is flagged.** The label's key has probably been renamed. Open a
  labeled video, view the page source and search for "Made with AI". Put the
  key that contains it in `MARKER` at the top of `detect.js`.
- **Labeled Shorts aren't skipped.** The "next" button has probably changed.
  Inspect it in the Shorts player and update `shortsNext` in the `CFG` block
  at the top of `content.js`.
- **Flagged videos aren't hidden on some page.** The card element has probably
  changed. Inspect the card and add its tag name to `outerCards` in `CFG`.

When opening an issue, describe the page you were on and what the popup shows.

## Privacy

*Last updated 4 October 2026.*

**What the extension handles**

- **YouTube page content.** On `youtube.com`, it reads the video links on the
  page and fetches each video's page to check for YouTube's AI label.
- **A local cache.** The IDs of checked videos, whether each is labeled, and
  the day each unlabeled one was checked. It holds up to 10,000 videos (about
  110 KB); past that, the oldest unlabeled results are dropped first.
- **Your settings.** Whether the filter is on, and whether labeled videos are
  hidden or dimmed.

**Where it is stored**

Only in your browser (`chrome.storage.local`). Nothing is sent to the
developer or any third party. The only network requests go to `youtube.com`.

**Permissions**

Only `storage`. Content scripts run only on `https://www.youtube.com/*`.

**What is not collected**

No personal information, analytics or advertising. No data is sold or shared.

**Your control**

**Clear saved results** in the popup clears the cache. Removing the extension
deletes everything it stored.

**Contact**

Open an issue on this repository.

## Contributing

Issues and pull requests are welcome. There is no build step: edit the files,
reload the extension in `chrome://extensions` and refresh YouTube to test.

## Disclaimer

This project is not affiliated with or endorsed by YouTube or Google.
