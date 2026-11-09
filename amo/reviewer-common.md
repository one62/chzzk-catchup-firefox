치지직지직 is a Firefox extension for https://chzzk.naver.com/.

Build: the submitted extension contains readable JavaScript, HTML, CSS and SVG files. There is no transpilation, minification, or remote executable code required by the extension. Package manifest.json, src/, popup/, and icons/ at the archive root. Node.js is only needed for development checks (npm ci, npm test, npm run check); web-ext handles submission.

Permissions: storage saves user preferences locally. scripting dynamically registers or unregisters src/clip-compat.js when clip editor compatibility is enabled or disabled. Host access is restricted to https://chzzk.naver.com/*.

Clip compatibility: on the desktop Firefox clip editor page only, src/clip-compat.js exports a constant getter through Firefox's exportFunction/wrappedJSObject APIs to present a Chrome-compatible navigator.userAgent to page code. It does not modify HTTP User-Agent headers or expose extension APIs to page code.

Test: allow site access, open a live CHZZK broadcast and reload the page after installing. Open the extension popup to inspect catch-up controls, latency/buffer display, and feature switches. Toggle clip compatibility, reload the broadcast, and use its scissors button to open the clip editor. Clip creation requires a CHZZK account and a channel that permits clips. Playback and clip availability depend on the live service. No reviewer credentials are included.

Latency is an estimate using the CHZZK HTTP Date header and stream timing metadata. The extension declares no data collection. CHZZK page/player requests and the timing HEAD request use the CHZZK service.
