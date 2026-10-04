# Hide AI-Labeled Videos

A Chrome extension that hides YouTube videos labeled **"Made with AI"**.

It removes them from the home feed, subscriptions, search results, the
watch-page sidebar, channel pages and Shorts shelves. In the Shorts player it
skips them automatically.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Version](https://img.shields.io/badge/version-1.1.1-green)

## Features

- **Hide or dim**: remove labeled videos completely, or keep them visible with
  a red "AI-labeled" tag so you can see what the filter catches.
- **Shorts skipping**: labeled Shorts are skipped in the Shorts player.
- **Works in any language**: detection uses YouTube's page data, not the
  label's visible text.
- **Private**: no accounts, no analytics, no outside servers. See
  [Privacy](#privacy).
- **Status panel**: the popup shows what the extension is doing on the current
  tab, including whether the open video or Short is labeled.

## Demo Video

[Watch Demo Video](https://github.com/ryanch13579/Anti-YouTube-Slop/blob/main/Demo%20Video/Demo%20Video.mp4)

## Install

The extension is on the Chrome Web Store, but you can load it from source:

1. Clone the repository, or download it as a ZIP and unzip it somewhere
   permanent:
   ```sh
   git clone https://github.com/<your-username>/Anti-AI-Label-Video.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the project folder.
4. Open or refresh YouTube.

It should also work in other Chromium browsers (Edge, Brave, Opera, Vivaldi).

### Updating

Run `git pull` (or replace the files), click the reload arrow on the
extension's card in `chrome://extensions`, then refresh your YouTube tabs.

## Usage

Click the toolbar icon to:

- switch the filter on or off
- choose **Hide** or **Dim and tag them**
- see how many thumbnails were found and how many are labeled on this tab
- check whether the open video or Short has YouTube's label
- clear the cached results

## How it works

YouTube doesn't put the AI label on feed thumbnails. The label only appears on
each video's own page. So for every video card near the screen, the extension
fetches that video's page in the background, looks for the label, and
remembers the answer.

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (MV3). |
| `detect.js` | Finds the label in a page's data by matching the JSON key `"howThisWasMadeSectionViewModel":{`. |
| `content.js` | Finds video cards and checks those near the viewport, 3 at a time. Caches the answers, marks cards, and skips labeled Shorts. |
| `content.css` | Hides or dims marked cards. |
| `popup.html` / `popup.js` | The toolbar popup. |
| `icons/` | Extension icons. |

## Privacy

*Privacy policy, last updated 4 October 2026.*

Hide AI-Labeled Videos is a browser extension that hides videos YouTube has
labeled as made with AI.

**What the extension handles**

- YouTube page content. On `youtube.com`, the extension reads the video links
  on the page and fetches each video's YouTube page to check whether YouTube
  has labeled it as made with AI.
- A local cache. The IDs of the videos it has checked, whether each one is
  labeled, and when it was checked. "Labeled" results are kept for 90 days.
  "Not labeled" results are checked again after 7 days, because YouTube can add
  a label later.
- Your settings. Whether the filter is on, and whether labeled videos are
  removed or dimmed.

**Where it is stored**

All of this is stored only in your browser (`chrome.storage.local`). It is
never sent to the developer or to any third party. The only network requests
the extension makes are to `youtube.com`.

**Permissions**

The only permission requested is `storage`. Content scripts run only on
`https://www.youtube.com/*`.

**What is not collected**

The extension does not collect personal information, does not use analytics or
advertising, and does not sell or share any data.

**Your control**

The Reset button in the popup clears the cache. Removing the extension deletes
everything it stored.

**Contact**

Questions about this policy: open an issue on this repository.

## Limitations

- **Only YouTube's own label counts.** AI voiceovers, scripts and stylized or
  animated AI content are often unlabeled, so they aren't hidden.
- **Brief flash on first check.** A video shows until its first check finishes.
  After that the result is cached and the video is hidden right away.
- **Background requests.** A fresh feed checks many videos at once. If YouTube
  answers "too many requests", the extension pauses and tries again later.
  Videos that haven't been checked stay visible.
- **Shorts.** The first time a labeled Short comes up, it plays for a moment
  before the check finishes. Then it is skipped.
- **Direct links still play.** Opening a labeled long-form video directly still
  plays it. Only its thumbnails are hidden.
- **Playlists and mixes** are not filtered.

## Troubleshooting

YouTube changes its page structure from time to time. If the extension stops
working, these are the likely fixes:

- **Nothing is flagged.** YouTube has probably renamed the label's key. Open a
  labeled video, view the page source and search for "Made with AI". Put the
  key that contains it in `MARKER` at the top of `detect.js`.
- **Labeled Shorts aren't skipped.** YouTube has probably changed the "next"
  button. Inspect it in the Shorts player and update `shortsNext` in the `CFG`
  block at the top of `content.js`.
- **Flagged videos aren't hidden on some page.** YouTube has probably changed
  the card element. Inspect the card and add its tag name to `outerCards` in
  the `CFG` block at the top of `content.js`.

If you open an issue, please describe the page you were on and what the popup shows.

## Contributing

Issues and pull requests are welcome. There is no build step. Edit the files,
reload the extension in `chrome://extensions` and refresh YouTube to test.

## Disclaimer

This project is not affiliated with or endorsed by YouTube or Google.
