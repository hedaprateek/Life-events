# Connecting Instagram

This takes about an hour of setup, plus a wait for Meta's app review. There is no
shortcut around the review — publishing to Instagram from your own software is a
permission Meta grants manually.

## What you need before starting

1. **An Instagram Business or Creator account.** In the Instagram app:
   *Settings → Account type and tools → Switch to professional account*. It's free
   and reversible. Personal accounts cannot publish through the API at all — the
   old Basic Display API that allowed it was retired.
2. **A Facebook Page** linked to that Instagram account.
3. **A public HTTPS address** for this server. Meta downloads your photos from a
   URL you provide, so `localhost` will not work for publishing.

## 1. Create the Meta app

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Pick the use case that includes **Instagram**.
3. Under *App settings → Basic*, note the **App ID** and **App secret**.
4. Add the **Instagram** product, and in its settings add this exact redirect URI:

   ```
   https://YOUR-DOMAIN/api/instagram/callback
   ```

   It must match byte for byte, including the scheme and any trailing path.

## 2. Request the permissions

In *App review → Permissions and features*, request:

| Permission | What it does here |
| --- | --- |
| `instagram_business_basic` | Read your account and your posts (the inbound half) |
| `instagram_business_content_publish` | Post to your account (the outbound half) |

Before approval you can still test everything, but **only with accounts added as
testers** in *App roles → Roles*. Add your own Instagram account there and the
whole flow works immediately — approval is only needed for accounts you don't own.

App review typically takes a couple of weeks and Meta will ask for a screencast
showing the flow. Recording yourself ticking "Share to Instagram" on an event and
pressing Publish is usually sufficient.

## 3. Configure this server

Copy `config.example.json` to `config.json` (it is git-ignored) and fill it in,
or set the same names as environment variables:

```json
{
  "PUBLIC_URL": "https://YOUR-DOMAIN",
  "IG_APP_ID": "your app id",
  "IG_APP_SECRET": "your app secret",
  "INBOUND_POLL_MINUTES": 15
}
```

| Setting | Meaning |
| --- | --- |
| `PUBLIC_URL` | Where Meta can reach this server. **Must be https** in production |
| `IG_APP_ID` / `IG_APP_SECRET` | From step 1. The secret never reaches the browser |
| `INBOUND_POLL_MINUTES` | How often to check Instagram for new posts (`0` disables) |
| `MEDIA_EXPOSURE_MINUTES` | How long a photo stays publicly fetchable while posting (default 60) |
| `PORT` | Defaults to 3000 |

## 4. Run it

```
node server/server.js
```

No `npm install` — the server uses only what ships with Node (18 or newer).

Open the address it prints, go to the **Instagram** tab, and press
**Connect Instagram**.

## Deploying somewhere always-on

Any host that runs Node and gives you HTTPS works — Render, Railway, Fly.io, or a
small VPS behind Caddy or nginx. Two requirements:

- **Persist `server/data/`.** It holds your records, your photos, and the access
  token. On platforms with ephemeral disks, attach a volume, or you will lose
  everything on redeploy.
- **Put it behind a login.** This server has no user accounts — anyone who reaches
  the URL can read and edit your family timeline. Use your platform's access
  control, or a reverse proxy with basic auth. The `/media/` path must stay
  reachable by Meta, so exclude it from any auth you add.

## How your photos are exposed

Instagram will not accept an image upload; it insists on fetching the image from a
public URL itself. So publishing necessarily makes a photo briefly public.

This server limits that as much as the API allows:

- Photos are **not** served at all by default — `/media/<id>.jpg` returns 404.
- When you press Publish, only that event's photos open up, at unguessable IDs.
- The window closes as soon as publishing finishes, or after
  `MEDIA_EXPOSURE_MINUTES`, whichever comes first.

An image Meta has already fetched is on Instagram's CDN regardless, which is the
point of posting it. But nothing else in your timeline is ever reachable.

## Limits worth knowing

- **~25 API posts per rolling 24 hours** per account.
- **JPEG only**, aspect ratio between 4:5 and 1.91:1. The app already converts
  photos to JPEG, but a very tall or very wide image will be rejected by Instagram.
- **Carousels** hold up to 10 images; events with more will refuse to publish.
- **No stories or reels** from this integration — feed posts only.
- **Inbound sync is polling.** Instagram has no push for your own new posts, so a
  post made in the Instagram app appears here within `INBOUND_POLL_MINUTES`.
- **Editing is one-way.** Instagram's API cannot change a caption after posting, so
  editing an already-published event here does not update Instagram.

## When something fails

Errors are shown on the event in the Instagram tab's *Failed* list, with Meta's
message and a plain-English hint. The common ones:

| Message | Usually means |
| --- | --- |
| *Session has expired* | Reconnect the account — the token was revoked |
| *media could not be downloaded* | `PUBLIC_URL` is wrong, or Meta cannot reach your server |
| *Application request limit reached* | You hit the 25-posts-per-day ceiling |
| *permission* / *App Review* | The account is not a tester and the app is not approved yet |
