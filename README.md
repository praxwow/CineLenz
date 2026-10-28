# 🎬 CineLenz

**Spot a movie. Scan the poster. Discover the title.**

CineLenz is a Chrome/Chromium browser extension that helps identify movies and TV shows from poster images or selected webpage text. It uses on-device OCR or optional Gemini vision OCR to read a title, then looks up the result with the movie database you configure. The goal: fewer tabs, less retyping, and quicker discovery while you browse.

> **Important:** CineLenz is a bring-your-own-API-key extension. Local OCR works without an OCR API key, but movie lookups require your own OMDb or TMDB key. Gemini OCR is optional and requires your own Gemini API key. A provider may apply its own quotas, terms, or charges.

## ✨ Features

### 🖼️ Poster scanning

- **Drag-to-scan:** Activate the scanning shortcut, drag a box around a poster or title area, and let CineLenz read the selected region.
- **On-device OCR:** The bundled PP-OCRv6 Tiny models run locally through ONNX Runtime Web. This path does not send the poster crop to a cloud OCR service.
- **Optional Gemini OCR:** Use Gemini vision OCR for stylized, curved, embossed, metallic, warped, or 3D movie-logo typography. When selected, the cropped image is sent to Google's Gemini API using your own key.
- **Candidate matching:** OCR readings can be checked against the selected movie database to help find a matching title.
- **Cancel and recover:** Stop an in-progress scan and continue with manual search when needed.
- **Manual fallback:** If OCR cannot identify the title, enter it yourself rather than getting stuck on a failed scan.

### ⌨️ Customizable activation shortcut

- Default on Windows/Linux: **Ctrl + Alt + Z**.
- Default on macOS: **Command + Option + Z**.
- Record a custom shortcut in Settings. The supported combination uses at least one modifier key with a letter or number.
- **Sticky Cursor Mode:** Toggle scan mode on or off without holding the shortcut continuously. Use the shortcut again or press Escape to exit scan mode.

### 🔍 Select-text lookup

Select a movie or TV title in a headline, article, comment, or caption. CineLenz can show a floating **🎬 Rate** button beside the selected text. You can disable the floating button and use the right-click context-menu lookup instead.

### ⌕ Smart title autocomplete

Start typing a title in CineLenz search to see matching suggestions with poster thumbnails, release years, and media types where available. Select a suggestion to look up the matching record. Suggestions use the currently selected movie database and its API key.

### 🎨 Floating result cards

- View the matched title, year, available metadata, poster, and rating information.
- Move the result card using its drag handle.
- Change the card's light/dark appearance independently of the extension popup.
- Rating labels identify the data source where available. Ratings and metadata depend on the configured provider.

### 🗄️ Choose your movie database

CineLenz supports **OMDb** and **TMDB**. Select one in Settings and provide your own API key. Both provider keys can be saved locally so you can switch providers without re-entering them.

### ⚙️ Settings

- Card-based settings interface.
- API-key fields masked by default, with show/hide controls.
- Provider selection and OCR-engine selection.
- Gemini model selection, with an option to fetch the available model list using your Gemini key.
- Custom shortcut, Sticky Cursor Mode, floating Rate button, and result-card appearance settings.
- Inline explanations for important settings.

## 🔑 Setup and API keys

CineLenz does not provide shared API credentials. You supply the keys for the services you choose.

| Service | Used for | Required? | Where to get a key |
|---|---|---|---|
| **OMDb** | Movie and TV metadata and lookups | Required if OMDb is the selected database | [OMDb API](https://www.omdbapi.com/apikey.aspx) |
| **TMDB** | Movie and TV search and metadata | Required if TMDB is the selected database | [TMDB developer site](https://developer.themoviedb.org/) |
| **Google Gemini** | Optional vision-based OCR for difficult poster typography | Optional; required only when Gemini OCR is selected | [Google AI Studio](https://aistudio.google.com/apikey) |

**Local OCR requires no OCR API key**, but CineLenz still needs an OMDb or TMDB key to retrieve movie details. Gemini is an optional OCR path, not a replacement for the movie database key.

### First-time setup

1. Install CineLenz using the Chrome Web Store listing when it becomes available, or load the source folder in developer mode for local testing.
2. Open CineLenz and enter your own OMDb or TMDB API key in **Settings**.
3. Select the same provider you entered a key for.
4. Keep the OCR engine set to **PP-OCR (offline)** to use local OCR, or select **Gemini (online)** and enter your Gemini API key for cloud OCR.
5. Save the settings. If using Gemini, use the model refresh control to fetch the models available to your key.

Provider access, quotas, eligibility, and prices are controlled by each provider and may change. Check the provider's current terms and billing information before use.

## 🖱️ How to use CineLenz

### Scan a poster

1. Hold the configured activation shortcut. The default is **Ctrl + Alt + Z** on Windows/Linux and **Command + Option + Z** on macOS.
2. When the cursor becomes a crosshair, click and drag a box around the poster or title region.
3. Release the mouse to start OCR and title matching.
4. Review the result card. If the scan misses the title, stop the scan or use manual search.

### Look up selected text

1. Select a movie or TV title on a webpage.
2. Click the floating **🎬 Rate** button, or right-click and choose the CineLenz lookup option.
3. Review the result card.

### Use autocomplete

1. Open the CineLenz search field.
2. Type part of a movie or TV title.
3. Choose the matching suggestion using the mouse or keyboard.

## 🔒 Privacy and data handling

CineLenz is designed to make requests directly from the extension to the services needed for the feature you choose; it does not intentionally send API keys to GenCraftz-owned servers.

- **API keys:** User-provided API keys are stored in Chrome's `chrome.storage.local` and remain available across browser restarts. They are not intentionally synchronized across Chrome devices. If you previously used a build that stored keys in Chrome sync storage, the extension includes migration logic that moves legacy stored keys to local storage and removes the old synced copies.
- **Preferences:** Non-secret settings, such as selected provider, OCR choice, shortcut, or appearance preferences, may be stored using Chrome extension sync storage.
- **Local OCR:** The bundled PP-OCRv6 Tiny engine processes the selected image crop on-device for that OCR step.
- **Gemini OCR:** When selected, the cropped image is sent to Google's Gemini API. Google handles that request under its applicable terms and data policies.
- **Movie lookup and autocomplete:** Search terms and relevant API keys are sent directly to the currently selected OMDb or TMDB service for lookup and suggestions.
- **OCR.Space fallback:** The source contains an optional OCR.Space fallback path for cases where an OCR.Space key is present in stored settings. If that path is used, the crop is sent to OCR.Space. The normal visible settings interface focuses on PP-OCR and Gemini.
- **Retention:** Local storage is not guaranteed permanent. Keys may be lost if extension data is cleared, the extension is removed, or the Chrome profile is reset or lost. Information already sent to a third party is handled under that provider's own policies.

Read the [GenCraftz Privacy Policy](https://gencraftz.blogspot.com/p/privacy-policy.html) for the broader privacy statement. Review the relevant provider privacy policies and terms before sending data to third-party services.

## ⚠️ Limitations

- OCR can misread stylized lettering, low-resolution images, decorative logos, or images containing many competing text elements.
- Movie and TV data, posters, ratings, and availability depend on the selected third-party provider and its API response.
- CineLenz requires a working internet connection for movie database searches and for Gemini OCR.
- Local OCR can run without a cloud OCR request, but movie lookups still require an OMDb or TMDB API key and network access.
- Extensions cannot operate on every page. Chrome restricts extensions on certain browser-internal pages, Chrome Web Store pages, and other protected contexts.

## 🧾 Third-party notices

CineLenz uses third-party APIs and services. Their trademarks, content, API terms, quotas, and billing rules belong to their respective owners.

If you use TMDB data, include the required TMDB attribution in the extension's appropriate About/Credits area and follow TMDB's current logo and attribution guidelines. CineLenz is independent and is not endorsed or certified by TMDB. See [TMDB's developer documentation](https://developer.themoviedb.org/docs/faq).

IMDb, OMDb, TMDB, Google, Gemini, Chrome, and other named products are trademarks or service marks of their respective owners. Mentioning a product does not imply sponsorship or endorsement.

## 🚀 Installation

### Chrome Web Store

Install CineLenz from its official Chrome Web Store listing once it is published. **Coming Soon!**

### Developer installation

1. Download or clone the repository.
2. Open `chrome://extensions` in Chrome, or the equivalent extensions page in a compatible Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted CineLenz folder containing `manifest.json`.
6. Pin CineLenz for convenient access.

Use developer-mode installation for testing and development. For ordinary users, prefer the official store listing when available.

## 🧰 Tech stack

- Chrome Extension Manifest V3
- JavaScript, HTML, and CSS
- Bundled PP-OCRv6 Tiny detection and recognition models
- ONNX Runtime WebAssembly for local OCR inference
- Google Gemini API for optional vision-based OCR
- OMDb API or TMDB API for movie and TV metadata

## 📄 License

Add a `LICENSE` file to this repository before stating that the project uses a specific open-source license. If you intend to release CineLenz under MIT, include the complete MIT License text and ensure you have rights to distribute all bundled code, models, dictionaries, icons, and dependencies under their applicable licenses.

## 📬 Contact and links

- **Project:** GenCraftz by PraxWow
- **Contact:** [praxwow@gmail.com](mailto:praxwow@gmail.com)
- **Product article:** [CineLenz on GenCraftz](https://gencraftz.blogspot.com/2026/09/cinelenz-chrome-extension-for-instant.html)
- **Privacy policy:** [GenCraftz Privacy Policy](https://gencraftz.blogspot.com/p/privacy-policy.html)
- **Terms:** [GenCraftz Terms and Conditions](https://gencraftz.blogspot.com/p/terms.html)

Made with ❤️ by PraxWow.
