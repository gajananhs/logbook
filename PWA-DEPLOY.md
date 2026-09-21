# LOGBOOK — PWA, GitHub and Hostinger Git deploy

Stack unchanged: plain HTML/CSS/JS + PHP (PDO) + MySQL. No build step, no npm, no FTP, no
GitHub Actions. Everything in this folder is already built — what you commit is what runs.
Only `index.html` was edited (additive `<head>` tags + the two extra asset tags).

## Every release (the only routine you need)

1. Make your changes.
2. Open `sw.js`, change the first constant: `const APP_VERSION = '1.0.0';` -> `'1.0.1'` (any new value).
3. `git add -A && git commit -m "what changed" && git push`
4. Hostinger: automatic if the webhook is set, otherwise hPanel -> Advanced -> Git -> Deploy/Pull.
5. If the site looks stale, purge the LiteSpeed cache in hPanel.
6. Open the app: installed users see **Update available** -> Update. (Forgetting step 2 means
   installed apps keep serving their old files.)

Adding a new css/js/image the app needs offline? Add its path to `PRECACHE_FILES` (top of `sw.js`).

## First-time setup

1. GitHub: create an empty **private** repository (no README/licence).
2. Copy this zip's contents into your project folder (overwrite `index.html`). Keep your real
   `config.php` and `api/config_smtp.php` in the folder — `.gitignore` keeps them out of Git.
3. If the server already has an `.htaccess` in the app folder, merge it into this one first;
   a Git pull overwrites it.
4. In the project folder:
   ```bash
   git init -b main
   git status          # config.php and api/config_smtp.php must NOT be listed
   git add .
   git commit -m "Convert LOGBOOK to an installable PWA"
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```
5. Hostinger (hPanel -> your site -> Advanced -> Git; labels may differ slightly):
   - Repository: the **SSH** URL `git@github.com:<you>/<repo>.git`. Branch: `main`.
   - Install directory: the folder the app lives in (blank = `public_html`).
   - Private repo: hPanel shows an SSH public key -> GitHub repo -> Settings -> Deploy keys ->
     Add deploy key (read-only is enough).
   - Auto-deploy: copy the webhook URL hPanel shows -> GitHub repo -> Settings -> Webhooks ->
     Add webhook (content type `application/json`, event: push).
6. **config.php is not in the repo.** Safe order for an existing live app:
   a. File Manager: download `config.php` and `api/config_smtp.php` as a backup.
   b. Rename the live folder to `<name>_old` (instant rollback copy).
   c. Create the Git connection with the original folder name as the install directory, then Deploy.
   d. Upload `config.php` to the folder root and `config_smtp.php` into `api/`.
   e. Test login, then delete `<name>_old` after a few days.
   (If hPanel accepts your existing non-empty folder, skip b — pulls never touch files that
   aren't in the repo, so your config files stay put.)

## Verify on the live HTTPS site (Chrome/Edge DevTools)

- `https://yourdomain/<app>/.git/config` and `.../db/schema.sql` must return **403**.
- Application -> Manifest: no errors, icons load, installable.
- Application -> Service Workers: `sw.js` "activated and running"; Cache Storage shows
  `logbook-precache-v2-<APP_VERSION>`.
- Network -> Offline -> reload: app shell (or the offline page) loads; red banner shows.
- Install: address-bar install icon (desktop/Android); iPhone: Safari -> Share -> Add to Home Screen.

## Caching rules

- Never cached: `/api/*`, any `.php`, all POSTs. Tasks, attendance, PINs, reports are always live.
- Precached (revision = APP_VERSION): css, js, icons, manifest, offline page. `?v=NN` in
  `index.html` is ignored for matching — APP_VERSION is what controls updates.
- `index.html`: network-first, stored by plain path only, so one-time SSO links and email deep
  links are never cached. Google Fonts cached separately.
- Bumping APP_VERSION deletes every old logbook cache on activation.

## Limits of the existing app (unchanged on purpose)

- Login lives in memory in `app.js`; closing/reloading the app returns to the login screen.
- Offline: banner only. Saves fail with the app's normal error; nothing is queued or replayed.
- No push notifications or background sync (would need new server endpoints).
