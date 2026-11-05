# everreed-auth-shim

Single-purpose static site hosted at **`https://auth.everreed.app`**. Its only
job is to return an OAuth callback (token pair or authorization code) to
EverReed through the existing `everreed://oauth/auth` route. Google sign-in,
Apple sign-in and native identity linking share this page. If the browser
blocks the automatic handoff, the reader can tap **Return to EverReed** once
while the page stays open. The retry expires after one minute and is discarded
when the page is hidden or the reader leaves.

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

The page scrubs its address before attempting the native return. Its existing
best-effort probe sends only the host, path, fixed stage and route, parameter
counts and presence flags. A probe establishes that the callback page ran.
Only the app can confirm that a reader's session opened.

## Local regression checks

Run the fixture suite from this repository with Node.js 20 or later:

```sh
node --test .tests/native-callback.test.mjs
```

The tests execute the page's own script with synthetic callbacks and a simulated
browser. A release also needs physical iOS and Android sign-in checks.

## Release verification

A push to the Netlify production branch may publish immediately. Obtain owner
release approval before pushing. In the existing Netlify site for
`auth.everreed.app`, verify the source repository and published revision.
Compare the public file with the approved checkout using an ordinary GET with
no callback parameters. Run from the approved checkout on macOS or Linux:

```sh
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

url = "https://auth.everreed.app/native-callback.html"
expected = sha256(Path("native-callback.html").read_bytes()).hexdigest()
with urlopen(url, timeout=15) as response:
    assert response.status == 200 and response.geturl() == url
    assert response.headers.get_content_type() == "text/html"
    assert "no-store" in response.headers.get("Cache-Control", "").lower()
    assert response.headers.get("Referrer-Policy", "").lower() == "no-referrer"
    assert sha256(response.read()).hexdigest() == expected
print("Verified callback bytes and headers:", expected)
PY
```

On a physical iPhone and Android phone, use an existing test account. Start
Google and Apple sign-in from EverReed where offered. Confirm the correct
account opens and remains signed in after reopening the app. If the browser
keeps the return page open, tap **Return to EverReed** and check that Back
does not repeat the handoff. On a separate attempt, cancel at the provider
and confirm that sign-in can be started again. Record the device, provider and
outcome only. Keep the reader-facing release note pending until these checks pass.
