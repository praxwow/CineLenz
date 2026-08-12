🎬 CineLenz

Hold a shortcut, drag over any movie or TV poster, get the rating instantly.

CineLenz is a Chrome extension that reads titles straight off poster images and comments/headlines on any website using OCR, then looks them up on OMDb or TMDB — no typing, no tab-switching, no copy-pasting a mangled title into Google.

✨ Features
🖼️ Poster scanning
Drag-to-scan: hold your activation shortcut, drag a box around any poster or title text, and get an instant rating card.
Dual OCR engines:
Tesseract (offline) — runs entirely on-device, free, no data ever leaves your browser.
Gemini (online) — a vision-AI model that reads stylized, curvy, 3D, or heavily decorated movie-logo fonts far more accurately than classic OCR. Bring your own free Gemini API key; the model list is fetched live from your account so it never goes stale.
Multi-guess matching: Gemini returns several ranked readings per scan and each is tried against the movie database, so a close-but-imperfect first guess doesn't sink the whole scan.
Stop anytime: a stop button on every loading state cancels the scan mid-flight and drops straight into manual search — no waiting out a slow OCR pass.
Manual fallback: if nothing matches, type the title yourself — always available, never a dead end.
⌨️ Fully customizable activation shortcut
Default is Ctrl+Alt+Z on Windows/Linux, Cmd+Option+Z on macOS (auto-detected).
Record your own shortcut — click, press any key combination, save. Works with any combination of Ctrl/Alt/Shift/Cmd plus a letter or number.
Sticky Cursor Mode — toggle the shortcut once to lock scan mode on instead of holding keys down; press it again (or Esc) to release.
🔍 Select-text rating lookup

Highlight any movie or show title in a comment, caption, headline, or article — no key combo needed — and a Rate button appears next to your selection.

🎨 Result cards
Draggable: grab the grip handle to reposition the result card anywhere on screen.
Dark/light theme toggle for the cards themselves, independent of the popup UI.
🗄️ Movie database
Switch freely between OMDb and TMDB as your data source.
Both API keys are remembered, so you can flip providers anytime without re-entering anything.
⚙️ Settings
Clean, card-based settings screen that slides in over the main view (no page reload, no clutter).
API keys are masked by default (password-style) with a show/hide toggle per field.
Every feature has inline, expandable explanations — nothing is hidden behind jargon, but nothing clutters the main view either.
🔒 Privacy
All API keys and preferences are stored locally via chrome.storage.sync — never on a third-party server.
Tesseract OCR never sends anything off-device.
Poster images are only sent externally if you explicitly enable Gemini (or the optional OCR.space fallback), using your own API key.
🚀 Installation
Clone or download this repository.
Open chrome://extensions in Chrome (or any Chromium-based browser — Edge, Brave, etc.).
Enable Developer mode (top-right toggle).
Click Load unpacked and select the CineLenz folder.
Pin the extension for quick access.
🔑 Setup

CineLenz is fully bring-your-own-key — nothing works out of the box until you add at least one:

Service	Used for	Free tier	Get a key
OMDb or TMDB	Movie/show ratings & metadata	Yes	Pick one in Settings → Movie Database
Gemini (optional)	More accurate OCR on stylized posters	Yes	Settings → Poster OCR Engine

Tesseract requires no key and works immediately — Gemini is an optional accuracy upgrade.

🖱️ Usage
Hold your activation shortcut (default Ctrl+Alt+Z / Cmd+Option+Z on Mac).
Your cursor becomes a crosshair — drag a box around a poster or title.
Release the mouse — OCR reads the title and a rating card appears.
Release the keys to exit scan mode.

Or, without any shortcut at all: just select any title text on a page and click the Rate button that appears.

🛠️ Tech stack
Manifest V3 Chrome Extension
Tesseract.js for offline OCR (via an offscreen document)
Google Gemini API for vision-based OCR
OMDb API / TMDB API for movie data
📄 License

Add your license of choice here (MIT recommended for open-source extensions).

☕ Support

Made with ❤️ by PraxWow — if this saves you time, consider supporting on Ko-fi.
