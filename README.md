# Logbook

Task, attendance and team log manager, built as an installable Progressive Web App.

- **Static site** — plain HTML, CSS and JavaScript. No framework, no server code, no build step.
- **Works offline** — the app shell, fonts and icons are cached by a service worker; data is stored in the browser.
- **Deploys on GitHub Pages** — every path is relative, so it runs unchanged at `https://<user>.github.io/<repo>/` or on a custom domain.
- **Starts with your organisation** — employees, departments, statuses, tasks, attendance and saved reports come from `assets/js/seed-data.js`.

## What the app does

| Area | Features |
|---|---|
| My tasks | Tasks assigned to you, progress updates (log / edit / delete), status changes, mark complete with efficiency, renew repeating work |
| Given | Tasks you assigned to others; edit, reassign, delete |
| Team (heads and admins) | Roster with open / overdue / completed / efficiency, view an employee's tasks and comments, assign, comment, filters, email and WhatsApp summary, **Excel import** (admins) |
| Assign | New task for yourself or someone you manage; daily / weekly / monthly repeating work |
| Time | Clock in / out with location, personal and team timelines, CSV export |
| More (admins) | Employees, departments and sub-departments, live status, reports (task, attendance, all departments), reports history |

Roles: **admin**, **department head**, **sub-department head**, **employee**. Who can see and assign to whom follows the role and department.

### Signing in

Type an employee's name exactly as it appears under **More → Employees** (capital letters don't matter). No PINs are shipped with the app: an admin sets each person's PIN from **More → Employees → Manage → Reset PIN**, and until then that account opens with the name alone.

**More → Reset this device** erases everything saved in that browser and restores the starting data.

### Starting data (`assets/js/seed-data.js`)

This file holds the employees (name, role, admin flag, department, sub-department, phone, joining date), departments and sub-departments, task statuses, every task with its updates, attendance, notifications and saved reports. It contains **no** PINs and no GPS coordinates.

**GitHub Pages serves every file publicly, even from a private repository** — anyone with the site link can read this file, including names, phone numbers, task details and attendance times. Only publish it if that is acceptable.

Edit the file to change what the app starts with; devices that already opened the app keep their saved copy until **Reset this device** is used.

## Important: where the data lives

Everything is saved in the browser's `localStorage` **on the device that is using the app**. There is no server, so:

- data is **not shared** between people or devices — each browser has its own copy;
- clearing site data, or **Reset this device**, removes it;
- PINs are stored as salted SHA-256 hashes, but a static site cannot keep anything secret from the person holding the device. Treat this build as a demo or a single-device tool, not as a secured multi-user system.

To make it multi-user, put a real API behind `assets/js/store.js` (see [Connecting a backend](#connecting-a-backend)).

## Project structure

```
.
├── index.html               App shell: sign-in, header, bottom tab bar
├── offline.html             Shown if a page is requested offline before it was cached
├── 404.html                 GitHub Pages "not found" page → returns to the app
├── manifest.json            PWA manifest (name, icons, colours, shortcuts)
├── sw.js                    Service worker (precache + runtime caching + updates)
├── .nojekyll                Tells GitHub Pages to serve the files as they are
├── .gitignore
├── README.md
└── assets/
    ├── css/style.css        All styles (design tokens, components, responsive rules, PWA cards)
    ├── js/
    │   ├── config.js        Settings you may edit (email recipient, WhatsApp number, …)
    │   ├── seed-data.js     Starting data: employees, departments, statuses, tasks, attendance, reports
    │   ├── store.js         Data layer: storage and business rules
    │   ├── app.js           Views and application logic
    │   ├── import-excel.js  Excel import (Team board, admins)
    │   └── pwa.js           Service-worker registration, install / update prompts, offline strip
    ├── fonts/               Fraunces, IBM Plex Sans, IBM Plex Mono (woff2) + licences
    ├── icons/               App icons, maskable icons, favicons, Apple touch icon
    ├── splash/              iOS launch screens
    └── vendor/xlsx.full.min.js   SheetJS 0.18.5 (Excel reader, loaded only when importing)
```

## Run it locally

A service worker needs `http://localhost` or HTTPS — opening `index.html` as a file will not work. Use any static server from the project folder:

```bash
# Python 3
python3 -m http.server 8080

# or Node.js
npx serve -l 8080 .
```

Then open <http://localhost:8080/>.

While developing, tick **DevTools → Application → Service Workers → Update on reload** (Chrome / Edge) so you always see your latest files.

## Build

There is none. The files in this repository are exactly what is served.

## Deploy to GitHub Pages

1. **Create the repository** on GitHub (for example `logbook`). Public works on every plan; private repositories need a paid plan for Pages.
2. **Push the files** — the contents of this folder must be at the repository root:

   ```bash
   git init -b main
   git add .
   git commit -m "Logbook PWA"
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

   Uploading through the website also works: **Add file → Upload files**, drag in everything *including* the `assets` folder, `.nojekyll` and `.gitignore`.
3. **Turn on Pages**: repository **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**.
4. Wait about a minute, then open `https://<your-username>.github.io/<your-repo>/`. The address is also shown at the top of the Pages settings screen.
5. **Install it**: in Chrome or Edge use the install icon in the address bar; on Android use the in-app "Install Logbook" card; on iPhone use Safari → Share → **Add to Home Screen**.

### Custom domain

Add the domain under **Settings → Pages → Custom domain** and tick **Enforce HTTPS**. No file changes are needed.

## Releasing an update

1. Make your changes.
2. Open `sw.js` and change `APP_VERSION` (for example `'3.0.0'` → `'3.0.1'`).
3. Commit and push. Pages redeploys automatically.

People who already have the app open or installed see an **Update available** card; choosing **Update** reloads into the new version. If you add a file the app needs offline, add its path to `SHELL_FILES` in `sw.js`.

Skipping step 2 means installed copies keep their previously cached files until the browser revalidates them.

## Settings

Edit `assets/js/config.js`:

| Setting | Effect |
|---|---|
| `summaryEmailTo` | Pre-filled recipient(s) for **Email summary** and **Send via email**. Empty = choose when sending. |
| `whatsappNumber` | Number for **Share via WhatsApp** (digits with country code). Empty = WhatsApp asks who to send to. |
| `salesReportUrl` | When set, **More** shows a **Back to Sales Report** link to that address. |

Email is sent by opening a Gmail compose window in the user's browser; there is no mail server.

## Excel import

Admins: **Team → Import Excel**. Use **Download a sample workbook** to get a correctly laid-out file with current dates.

The sheet needs a header row containing `RESPONSIBILITY` and two `date` columns (order date first, target date last). `TO NO`, `CUSTOMER NAME`, `PART NUMBER`, `ORD. QTY`, `B/L` and `remarks` are copied into the task details. You get a preview — matched employees, tasks per target date, skipped rows — before anything is created. Importing the same sheet twice does not create duplicates. A task with a future target date stays hidden from its assignee until that date.

## Connecting a backend

`assets/js/app.js` reads and writes data only through one function:

```js
LogbookStore.request(action, payload)   // returns a Promise
```

`assets/js/store.js` implements every action (`bootstrap`, `login`, `add_task`, `clock_in`, `generate_report`, …) in the browser. To use a server instead, replace the body of `request()` with a `fetch()` to your API that returns the same JSON shapes and rejects with an `Error` whose `message` is shown to the user. Nothing else needs to change.

## Browser support

Current Chrome, Edge, Firefox and Safari (desktop and mobile). Installation prompts are available in Chrome, Edge and Samsung Internet; Safari installs through **Add to Home Screen**.

## Third-party components

| Component | Licence |
|---|---|
| [SheetJS Community Edition](https://sheetjs.com) 0.18.5 (`assets/vendor/xlsx.full.min.js`) | Apache-2.0 |
| Fraunces (`assets/fonts`) | SIL Open Font License 1.1 — see `assets/fonts/OFL-Fraunces.txt` |
| IBM Plex Sans and IBM Plex Mono (`assets/fonts`) | SIL Open Font License 1.1 — see `assets/fonts/OFL-IBM-Plex.txt` |
