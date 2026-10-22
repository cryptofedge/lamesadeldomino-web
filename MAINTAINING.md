# Maintaining lamesadeldomino.com

This repo is the public website (GitHub Pages, `CNAME` → lamesadeldomino.com). Everything in it is public.
The game itself is built elsewhere and copied in as a finished build.

## What lives where

| Thing | Where | In this repo? |
|---|---|---|
| Website, privacy page, Play Store art | this repo | yes |
| Game build players get (`/play/` and the password-protected `/demo/`) | `demo/app/` | yes (built copy only) |
| Game **source code** | Tesana studio project 274478 (tesana.com/studio/274478) | no: export it when needed |
| Android app project + `.aab` | `Downloads\lamesadeldomino-android\` | **no** |
| Play Store **upload key** + its passwords | `Documents\lamesadeldomino-keys\` | **never**: copy by USB / Drive only |

The Play Store app only opens https://lamesadeldomino.com/play/, so pushing a new game build here updates the app too.
A new Android upload is only needed if the wrapper changes (see `play-store/LAUNCH-GUIDE.md`).

## Moving to a new computer

1. Copy `Documents\lamesadeldomino-keys\` and `Downloads\lamesadeldomino-android\` to the same paths on the new computer
   (USB or Google Drive, never GitHub). Without the key, no future Play update can be signed.
2. Install Git and Node.js (v20 or newer), then clone the site:
   `git clone https://github.com/cryptofedge/lamesadeldomino-web.git`
3. Set your Git name and email (commits so far are by `Eclat Universe <cryptofedge@gmail.com>`):
   `git config --global user.name "Eclat Universe"` and `git config --global user.email "cryptofedge@gmail.com"`

## Updating the game build (no Tesana credits needed)

AI changes in Tesana cost credits. Hand edits in Tesana's **Code** tab are free (save with Ctrl+S; *Rebuild* costs credits,
but you don't need it for the steps below).

1. In Tesana: project menu → **Export → Source code** (free). Download the zip when it's ready.
2. Unzip it into an empty folder.
3. In `src/online-lobby.ts`, replace the `elsewhere` message (it tells players to find the game on Tesana) with:
   `t('Las mesas en línea no están disponibles en esta copia del juego. Mientras tanto, juega contra la computadora.', 'Online tables are not available in this copy of the game. Meanwhile, play against the computer.')`
   (Online tables only work on Tesana's own page, so this copy plays against the computer.)
4. Build:
   ```
   npm install
   npx tsc --noEmit
   npx vite build --assetsDir _app
   ```
5. Swap the build into this repo:
   - delete everything in `demo/app/_app/`, copy in `dist/_app/*`
   - copy any **new** files from the export's `assets/` into `demo/app/assets/`
     (skip `generation-meta.json`, `ui/storefront.json`, `ui/.storefront_pass.json`)
   - keep `demo/app/shell.js`, `play.js` and `decoders/` as they are (already cleaned up)
   - in **both** `demo/app/game.html` and `play/index.html`, update the `_app/index-….js` and `_app/index-….css`
     names to the new ones from `dist/index.html`, and remove `<link>`s to `_app` files that no longer exist
6. Test locally (any static server from the repo root), open `/play/`, play a hand, check the browser console.
7. Commit and push. The live site updates about a minute later.

## Game rules (as built in October 2026)

- Pase corrido **+25**: you play, the other three (partner included) pass, and you can still play. Not on a tranque.
- Me acuesto **+50**: going out with a double (including the double blank). No official rulebook defines it; this
  interpretation comes from *acostarse* = playing a double. Change it in `src/rules.ts` if the table plays it differently.
- Capicúa **+25**: going out with a non-double that fits both open ends.
- A bonus that reaches 200 wins the match right away. Values are constants at the top of `src/rules.ts`.

### Testing bonuses without waiting for them

In a running solo match, the browser console can set up any position:

```js
// your last tile 2-5, open ends 2 and 5 → capicúa
__mesaSetup({hands:[['2-5'],['6-6','1-1'],['4-4','0-1'],['0-0','1-4']], chain:[['2-3',2,3,3],['3-5',3,5,1]], turn:0, scores:[0,0]})
```

`chain` entries are `[tile, leftEnd, rightEnd, seat]`. Seat 0 is you, 2 is your partner. Vibration only fires on phones.
