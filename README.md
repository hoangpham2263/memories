# Hoang's Memories

A travel map of the places I have visited in Vietnam, kept through photos.

**Website:** https://hoangpham.is-a.dev/memories/

## Features

- Map of Vietnam's **34 provinces and cities** (after the 2025 merger), including the Hoàng Sa (Paracel) and Trường Sa (Spratly) archipelagos. Visited provinces are colored, with a "Visited x/34" counter.
- Click a province to see its photos, with a timeline by month.
- Photo upload (admin mode): reads GPS and capture date from EXIF and assigns the province automatically; photos without GPS let you pick a province. Supports HEIC and compresses automatically to at most 2560px.
- Photos are stored in Google Drive (a private folder) through a Cloudflare Worker that keeps a long-lived connection, so there is no need to sign in again.

## Structure

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | User interface |
| `vn-34.json` | Boundaries of the 34 provinces and cities (merged from the former 63 provinces under Resolution 202/2025/QH15) |
| `vendor/exifr.full.umd.js` | Reads EXIF and GPS data |
| `worker/` | Cloudflare Worker: Google Drive, photo list (KV), image proxy |

## Worker setup (once)

1. Google Cloud Console → enable the **Google Drive API** → create an **OAuth client ID** of type *Web application* and add this Authorized redirect URI:
   `https://memories-api.hoangpham2263.workers.dev/oauth/callback`
2. OAuth consent screen → **Publish app** (In production) so the refresh token does not expire after 7 days.
3. Set the secrets:

```bash
cd worker
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

4. Open the page, click the lock icon and enter the admin password. The page then opens the Google Drive connection step automatically.

## Tech stack

Plain HTML, CSS and JavaScript · Leaflet · exifr · heic2any · GitHub Pages · Cloudflare Workers + KV · Google Drive API
