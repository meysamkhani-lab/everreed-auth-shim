# everreed-auth-shim

Single-purpose static site hosted at **`https://auth.everreed.app`**. Its only
job is to receive Supabase OAuth implicit-flow redirects, read tokens from the
URL fragment, and fire the `everreed://oauth/auth` custom-scheme deeplink that
Despia uses to route the WebView back to `/auth`.

## Why a separate site

The main EverReed app cannot host this callback page:

- `https://everreed.app/native-callback.html` — Android App Links
  (`/.well-known/assetlinks.json`, relation `handle_all_urls`,
  package `com.despia.everread`) intercept the URL before Chrome Custom Tabs
  can run JS. Probe never fires.
- `https://everreed.lovable.app/native-callback.html` — Lovable publish edge
  302-redirects `lovable.app` → `everreed.app`. Browser ends up on the
  App-Linked host anyway.
- Supabase Edge Functions — gateway forces `text/plain`.
- Supabase Storage public buckets — Android refuses unverified `text/html`.

`auth.everreed.app` solves this because:

- It is a separate host (App Links are scoped per host).
- This repo does **not** include `/.well-known/assetlinks.json`.
- Netlify config has **no** redirect to everreed.app and **no** SPA fallback.

## Setup

1. Create a new Netlify site from this repo.
2. Add custom domain `auth.everreed.app` in the Netlify dashboard.
3. Add a CNAME `auth` → `<site>.netlify.app` at the everreed.app DNS provider.
4. Wait for SSL to provision.
5. Verify with:

   ```sh
   curl -I https://auth.everreed.app/native-callback.html
   ```

   Expect `200 OK` with `content-type: text/html`. There must be **no** 3xx
   redirect in the response chain.

6. In the Supabase / Lovable Cloud Auth settings, add to the Redirect URLs
   allow list:

   ```
   https://auth.everreed.app/native-callback.html
   https://auth.everreed.app/**
   ```

7. Tell the EverReed main repo maintainer to flip
   `supabase/functions/auth-start/index.ts` `redirect_to` to:

   ```
   https://auth.everreed.app/native-callback.html?deeplink_scheme=everreed
   ```

## Diagnostics

Each callback hit fires a `sendBeacon` to the EverReed
`auth-callback-probe` edge function with **token-safe** metadata only (param
key names, host, pathname, presence booleans — never token values). Check
that function's logs to confirm the shim actually executed on a given device.
