'use strict';

const DEFAULTS = { enabled: true, mode: 'hide' };
const $ = (id) => document.getElementById(id);
const modeRadios = document.querySelectorAll('input[name="mode"]');

let settings = { ...DEFAULTS };

// ---- Settings and totals ----------------------------------------------------

function renderSettings() {
  $('enabled').checked = settings.enabled;
  $('modes').disabled = !settings.enabled;
  for (const r of modeRadios) r.checked = r.value === settings.mode;
}

function renderCounts(verdicts = {}) {
  const entries = Object.values(verdicts);
  $('total').textContent = entries.length.toLocaleString();
  $('ai').textContent = entries.filter(([ai]) => ai).length.toLocaleString();
}

function save() {
  chrome.storage.local.set({ settings });
  renderSettings();
}

chrome.storage.local.get(['settings', 'verdicts']).then((got) => {
  settings = { ...DEFAULTS, ...got.settings };
  renderSettings();
  renderCounts(got.verdicts);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.verdicts) renderCounts(changes.verdicts.newValue);
});

$('enabled').addEventListener('change', (e) => {
  settings.enabled = e.target.checked;
  save();
});

for (const r of modeRadios) {
  r.addEventListener('change', () => {
    settings.mode = r.value;
    save();
  });
}

$('clear').addEventListener('click', () => chrome.storage.local.remove('verdicts'));

// ---- What the extension is doing in the current tab ------------------------

function describeOpenVideo(v) {
  const shorts = v.kind === 'shorts';
  return {
    labeled: shorts ? 'YouTube labels it as AI, so it is skipped.' : 'YouTube labels it as AI. Its thumbnail is hidden in feeds.',
    'not labeled': 'YouTube has not labeled it as AI, so it cannot be filtered.',
    checking: 'Checking…',
    unknown: 'Not checked yet.',
  }[v.label];
}

function describeProblem(r) {
  const l = r.lookups;
  if (l.pausedSeconds) return `YouTube is refusing checks (${l.lastError}). Paused for ${l.pausedSeconds}s.`;
  if (l.failed && !l.answered) return `Checks are failing: ${l.lastError}.`;
  if (r.shorts.skipStuck) return 'Couldn\'t auto-skip a labeled Short.';
  if (!r.cards && r.strayLinks > 5) {
    return 'Video links were found but not recognised as thumbnails.';
  }
  return '';
}

function renderPage(r) {
  const title = $('page-title'), main = $('page-main'), video = $('page-video'), warn = $('page-warn');
  const open = r && r.openVideo;
  title.textContent = !open ? 'This tab' : open.kind === 'shorts' ? 'This Short' : 'This video';

  if (!r) {
    $('page').hidden = false;
    main.hidden = false;
    main.textContent = 'Not running in this tab. Open YouTube, or refresh the tab if it was open before the extension was installed or updated.';
    video.hidden = warn.hidden = true;
    return;
  }

  main.textContent = 'No video thumbnails found on this page.';
  main.hidden = !!r.cards || !!r.openVideo;

  video.hidden = !r.openVideo;
  if (r.openVideo) video.textContent = describeOpenVideo(r.openVideo);

  const problem = describeProblem(r);
  warn.hidden = !problem;
  warn.textContent = problem;

  $('page').hidden = main.hidden && video.hidden && warn.hidden;
}

async function refreshPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    renderPage(await chrome.tabs.sendMessage(tab.id, { type: 'aif-report' }));
  } catch {
    renderPage(null);
  }
}

refreshPage();
setInterval(refreshPage, 1000);
