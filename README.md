# Election Dashboard

A mobile-friendly dashboard for choosing which 2026 U.S. midterm election races
to follow and tracking unofficial results, powered by [civicAPI](https://civicapi.org).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The complete dashboard (the final HTML provided for this package) |
| `manifest.webmanifest` | Progressive Web App name, theme and icons |
| `sw.js` | Service worker for offline access to the app's shell |
| `icon-180.png` | iPhone/iPad home-screen icon |
| `icon-192.png`, `icon-512.png` | Installable web-app icons |
| `.nojekyll` | Tells GitHub Pages to serve these static files directly |
| `.gitignore` | Excludes local/editor files from Git |

## Important notes

- The app requests live data from `https://civicapi.org/api/v2` directly from
  each visitor's browser.
- The dashboard refreshes followed-race results about every 30 seconds while
  the dashboard is visible. Actual updates depend on civicAPI's data and availability.
- Followed races are stored in each visitor's browser via `localStorage`.
  They do not synchronize across devices or browser profiles.
- The service worker caches only this site's static files for an offline
  fallback. **Live results are unavailable without an internet connection.**
- Results are unofficial until confirmed by election authorities.
