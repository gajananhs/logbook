/* LOGBOOK PWA layer — registers the service worker and adds the online/offline
 * banner, the install prompt and the update prompt.
 *
 * Standalone on purpose: it does not modify or depend on assets/app.js. The
 * only things it reads from the app are the #mainScreen / #newUserInput /
 * #tabBar elements (read-only). Delete the <script> tag for this file in
 * index.html and the app behaves exactly as it did before the PWA work.
 */
(function () {
  'use strict';

  var SW_URL = 'sw.js';                       // relative: works at the domain root or in a sub-folder
  var INSTALL_DISMISS_KEY = 'logbook_pwa_install_dismissed';
  var INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  var noop = function () {};

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html) n.innerHTML = html;
    return n;
  }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  /* ------------------------------------------------------------------ UI */
  var status, dock;
  function buildUi() {
    status = el('div', 'pwa-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    document.body.insertBefore(status, document.body.firstChild);

    dock = el('div', 'pwa-dock');
    document.body.appendChild(dock);
  }

  /* ------------------------------------------------- online / offline */
  var hideTimer = null;
  function showStatus(kind, text) {
    clearTimeout(hideTimer);
    status.className = 'pwa-status show ' + kind;
    status.textContent = text;
    document.documentElement.classList.add('pwa-banner-on');
  }
  function hideStatus() {
    status.className = 'pwa-status';
    document.documentElement.classList.remove('pwa-banner-on');
  }
  var offline = false;
  function goOffline() {
    if (offline) return;
    offline = true;
    showStatus('offline', "You're offline — changes can't be saved until you reconnect.");
  }
  function goOnline() {
    if (!offline) return;
    offline = false;
    showStatus('online', 'Back online');
    hideTimer = setTimeout(hideStatus, 2500);
  }
  // navigator.onLine only says "a network interface is up" (office Wi-Fi with no
  // internet still reports true), so confirm with a tiny real request first.
  function verifyOnline() {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    return fetch('manifest.json?ping=' + Date.now(), { method: 'HEAD', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(t); return r.ok || r.status < 500; })
      .catch(function () { clearTimeout(t); return false; });
  }
  function onBrowserOnline() {
    verifyOnline().then(function (ok) {
      if (ok) goOnline();
      else { goOffline(); setTimeout(onBrowserOnline, 10000); }
    });
  }
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', onBrowserOnline);

  /* ----------------------------------------------------- update prompt */
  function onLoginScreen() {
    var main = document.getElementById('mainScreen');
    var name = document.getElementById('newUserInput');
    var pin = document.getElementById('newUserPin');
    var typing = (name && name.value) || (pin && pin.value);
    return (!main || main.style.display === 'none') && !typing;
  }
  var updateCard = null;
  function offerUpdate(worker) {
    // Nothing to lose on an empty login screen: apply silently.
    if (onLoginScreen()) { worker.postMessage({ type: 'SKIP_WAITING' }); return; }
    if (updateCard) return;
    updateCard = el('div', 'pwa-card');
    updateCard.setAttribute('role', 'alertdialog');
    updateCard.setAttribute('aria-label', 'Update available');
    updateCard.innerHTML =
      '<div class="pwa-card-text"><b>Update available</b><span>A new version of Logbook is ready. Updating reloads the app.</span></div>' +
      '<div class="pwa-card-actions"><button type="button" class="pwa-btn pwa-btn-ghost" data-act="later">Later</button>' +
      '<button type="button" class="pwa-btn" data-act="update">Update</button></div>';
    updateCard.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'update') { e.target.disabled = true; e.target.textContent = 'Updating…'; worker.postMessage({ type: 'SKIP_WAITING' }); }
      if (act === 'later') { dock.removeChild(updateCard); updateCard = null; }
    });
    dock.appendChild(updateCard);
  }

  /* ----------------------------------------------- service worker setup */
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }   // first install claiming the page — no reload
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' }).then(function (reg) {
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
          });
        });
        // Look for a new version hourly, whenever the app comes back to the
        // foreground, and when the connection returns.
        setInterval(function () { reg.update().catch(noop); }, 60 * 60 * 1000);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(noop);
        });
        window.addEventListener('online', function () { reg.update().catch(noop); });
      }).catch(function (err) { console.warn('[PWA] service worker registration failed:', err); });
    });
  }

  /* ----------------------------------------------------- install prompt */
  var deferredPrompt = null;
  var installCard = null;
  function snoozed() {
    var t = parseInt(lsGet(INSTALL_DISMISS_KEY) || '0', 10);
    return t && (Date.now() - t) < INSTALL_SNOOZE_MS;
  }
  function hideInstall() { if (installCard && installCard.parentNode) installCard.parentNode.removeChild(installCard); installCard = null; }
  function showInstall(ios) {
    if (installCard || isStandalone() || snoozed()) return;
    installCard = el('div', 'pwa-card');
    installCard.setAttribute('role', 'dialog');
    installCard.setAttribute('aria-label', 'Install Logbook');
    installCard.innerHTML = ios
      ? '<div class="pwa-card-text"><b>Install Logbook</b><span>Tap the Share button, then <b>Add to Home Screen</b>.</span></div>' +
        '<div class="pwa-card-actions"><button type="button" class="pwa-btn pwa-btn-ghost" data-act="dismiss">Got it</button></div>'
      : '<div class="pwa-card-text"><b>Install Logbook</b><span>Add it to your home screen for quick, full-screen access.</span></div>' +
        '<div class="pwa-card-actions"><button type="button" class="pwa-btn pwa-btn-ghost" data-act="dismiss">Not now</button>' +
        '<button type="button" class="pwa-btn" data-act="install">Install</button></div>';
    installCard.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'dismiss') { lsSet(INSTALL_DISMISS_KEY, String(Date.now())); hideInstall(); }
      if (act === 'install' && deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (c) {
          if (c && c.outcome !== 'accepted') lsSet(INSTALL_DISMISS_KEY, String(Date.now()));
          deferredPrompt = null; hideInstall();
        });
      }
    });
    dock.appendChild(installCard);
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();               // we show our own, less intrusive prompt
    deferredPrompt = e;
    showInstall(false);
  });
  window.addEventListener('appinstalled', function () { deferredPrompt = null; hideInstall(); });

  function isIosSafari() {
    var ua = navigator.userAgent || '';
    var ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios && /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
  }

  /* --------------------------------- keep the active tab in view (touch) */
  function watchTabs() {
    var bar = document.getElementById('tabBar');
    if (!bar || !window.MutationObserver) return;
    var last = null, queued = false;
    function centre() {
      queued = false;
      var a = bar.querySelector('.tab.active');
      if (!a || a.getAttribute('data-tab') === last) return;
      last = a.getAttribute('data-tab');
      var delta = a.getBoundingClientRect().left - bar.getBoundingClientRect().left - (bar.clientWidth - a.offsetWidth) / 2;
      if (bar.scrollBy) bar.scrollBy({ left: delta, behavior: 'smooth' }); else bar.scrollLeft += delta;
    }
    new MutationObserver(function () { if (!queued) { queued = true; window.requestAnimationFrame(centre); } })
      .observe(bar, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  /* -------------------------------------------------------------- init */
  function init() {
    buildUi();
    if (!navigator.onLine) goOffline();
    watchTabs();
    if (isStandalone()) document.documentElement.classList.add('pwa-standalone');
    if (isIosSafari() && !isStandalone()) setTimeout(function () { showInstall(true); }, 4000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
