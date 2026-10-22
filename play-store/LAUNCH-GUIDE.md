# La Mesa del Dominó — Google Play launch guide

The Play Store app is a **Trusted Web Activity (TWA)**: a small Android app (`com.lamesadeldomino.twa`) that opens
https://lamesadeldomino.com/play/ full screen, with no browser bar. Game updates on the website reach the app instantly;
a new Android upload is only needed if the wrapper itself changes.

## What's already done

| Need | Where |
|---|---|
| Package name registered in Android developer verification | `com.lamesadeldomino.twa` (Registered, 3 keys) |
| App start page (ungated, landscape, full screen) | https://lamesadeldomino.com/play/ |
| Web app manifest (name, icons, colors) | `play/manifest.json` |
| Digital Asset Links (lets the app hide the browser bar) | https://lamesadeldomino.com/.well-known/assetlinks.json — new upload key `CD:82:3F:89:…:54:69:69` plus the original `18:48:74:1F:…:98:4E:AF` |
| **Android app, ready to upload** (built 2026-10-18 with Bubblewrap 1.27) | `Downloads\lamesadeldomino-android\app-release-bundle.aab` — version code 2, version 1.0.0, targets Android 16 (API 36), runs on Android 7.0+ |
| Privacy policy URL | https://lamesadeldomino.com/privacy.html |
| Play icon 512×512 | `assets/playstore/icon-512.png` |
| Feature graphic 1024×500 | `assets/playstore/feature-graphic.png` |
| 3 phone screenshots | `assets/playstore/screenshot-1-registro.jpg`, `-2-salon.jpg`, `-3-mesa.jpg` |

Checked on 2026-10-16 in the live game: guest entry works, the profile is saved only on the device, chips are decorative,
there are no ads and no purchases, and the online-tables screen says *"Las mesas en línea no están disponibles en esta copia
del juego"* — so the app is single-player against the computer.

## The Android app and its key (on this PC — never on GitHub)

The original Oct 8 build and its key stayed on another computer, so the app was rebuilt here on 2026-10-18 with a **new upload key**:

- App project and output: `C:\Users\FELLITO\Downloads\lamesadeldomino-android\`
  - `app-release-bundle.aab` — **the file you upload to Google Play**
  - `app-release-signed.apk` — for installing on your own Android phone to try it
  - `twa-manifest.json` — the app's settings (name, icon, colors, start page)
- Upload key: `C:\Users\FELLITO\Documents\lamesadeldomino-keys\lamesadeldomino-upload.keystore`
- Its alias, password and fingerprint: `signing-key-info.txt` in the same folder

New upload-key SHA-256: `CD:82:3F:89:72:8A:10:15:94:DE:79:6B:CD:D3:9F:15:07:63:32:AC:90:C3:64:D2:0F:E5:F5:54:FF:54:69:69`

**Back up the `lamesadeldomino-keys` folder in two places (Google Drive + USB) and never share it.** Every future update must be
signed with this key. If the old Oct 8 files turn up later, keep them too, but use this new key for Play.
Build tools live in `C:\Users\FELLITO\.bubblewrap` (Java 17, Android SDK, Bubblewrap). AVG Antivirus inspects HTTPS here, so
Java needs `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=Windows-ROOT` to download anything.

## Steps in Play Console (only you can do these)

1. **Create the app** — Play Console → *Create app*: name **La Mesa del Dominó**, default language **Español (Estados Unidos)** or
   **Español (Latinoamérica)**, **Game**, **Free**. (The developer name on the listing is the same as Cindy Career Copilot's —
   both apps are in the same developer account.)
2. **Closed testing → Create release** → accept **Play App Signing** → upload `Downloads\lamesadeldomino-android\app-release-bundle.aab`
   → release notes → save. (If Play says the upload key doesn't match, an older build was uploaded before: *App integrity →
   Request upload key reset*, and give Google the new key's certificate — ask me to export it.)
3. **Testers**: add an email list with **12 or more Google accounts** (the same people testing Cindy can test this too) → roll out.
4. **Send me Google's app-signing fingerprint**: *Test and release → App integrity → App signing* → copy the
   **App signing key certificate → SHA-256**. It must be added to `assetlinks.json` next to the upload key, or the installed
   app will show a browser address bar. (I add it and publish the site; it takes a minute.)
5. **Fill in App content** using the answers below, then the **Store listing** with the text below.
6. Install from the testers' link on a real Android phone: it should open full screen in landscape, with no address bar.
7. Keep the 12+ testers opted in for **14 days in a row** → Dashboard → **Apply for production access** → promote the release.

## Store listing copy (paste-ready)

**App name (≤30):** La Mesa del Dominó

**Short description (≤80):**
Dominó dominicano por parejas en una mesa de casino de lujo. Sin apuestas.

**Full description (≤4000):**
```
La Mesa del Dominó — donde se demuestra quién sabe jugar.

Dominó dominicano auténtico, por parejas, en una mesa de casino de lujo: fieltro, oro y madera pulida.

REGLAS DE PATIO
• El doble seis abre la primera mano
• Bonos: pase corrido (25), me acuesto (50) y capicúa (25)
• Tranque: gana la pareja con menos puntos
• Mesa en serpiente con esquinas reales
• La primera pareja en llegar a 200 puntos gana

JUEGA EN PAREJA
• Tú y tu compañera contra dos rivales de la computadora
• Rivales con estrategia: sueltan las fichas pesadas y trancan a quien pasó
• Elige rivales relajados, clásicos o afilados
• Pistas en tu turno cuando las necesites

TU ESTILO
• Crea tu personaje: rostro, atuendo y accesorios
• Colección VIP gratis de fichas y tapetes
• Experiencia, niveles y la Ruleta del Patrón: un giro gratis cada día que da experiencia
• Guerras de peñas contra la computadora

SIN APUESTAS, SIN ANUNCIOS, SIN COMPRAS
Las fichas son decorativas y no tienen valor monetario real. No necesitas crear una cuenta: tu perfil se guarda solo en tu teléfono.

En español e inglés.

Powered by Eclat Universe · © 2026 La Mesa del Dominó
```

English listing (optional, add as a translation):
- Short: `Dominican partnership dominoes at a luxury casino table. No wagers.`
- Full: translate the above, keeping the same facts. Don't add online play, tournaments or spectator mode — they aren't in this copy of the game, and Google checks listings against the app.

**Category:** Games → Board · **Tags:** dominoes, board game, card & board
**Contact email:** an inbox you check (required) · **Website:** https://lamesadeldomino.com
**Privacy policy:** https://lamesadeldomino.com/privacy.html

## App content — what to answer (be honest; Google checks)

- **Privacy policy:** https://lamesadeldomino.com/privacy.html
- **Ads:** No ads.
- **App access:** All functionality is available without special access (players can enter as a guest).
- **Target audience:** **18 and over** recommended — the casino look (chips, felt) can pull a younger audience into Google's
  stricter Families rules. 13+ is possible, but expect more review questions.
- **Content rating (IARC), category Game:** no violence, no sexual content, no bad language, no drugs.
  *Simulated gambling:* **No** — there are no casino games and no betting; chips are decorative, and the daily wheel only gives
  experience points. *Users interact / chat:* **No** (online tables are off in this copy). *Shares location:* No.
  *Digital purchases:* No.
- **Data safety:** **No data collected and no data shared.** The nickname, local password, character and progress stay in the
  phone's own storage and are never sent to a server. No ads, no analytics, no payments.
- **Account creation / deletion:** the game makes a *local profile on the phone*, not an online account — answer that users
  can't create an account.
- **Government, financial, health, news apps:** No.

## If online tables are switched on later

Online tables with text and voice chat are built into the game but turned off in this copy. Turning them on changes several
answers above: *Users interact* becomes **Yes**, the app needs a way to **mute/report/block** players, Data safety must list chat
messages and voice audio, and `privacy.html` must stop saying nothing leaves the device. Update all of these before that release.

## Release checklist
- [x] Android app rebuilt with a new upload key (2026-10-18); new fingerprint added to `assetlinks.json`
- [ ] `Documents\lamesadeldomino-keys` backed up in two places
- [ ] App created in Play Console; `.aab` uploaded to Closed testing with Play App Signing
- [ ] Google's app-signing SHA-256 added to `assetlinks.json` and the site republished
- [ ] Installed from the testers' link: full screen, landscape, no address bar
- [ ] App content forms and Store listing complete
- [ ] 12+ testers opted in for 14 days → apply for production access → promote the release
