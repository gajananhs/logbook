<?php
/**
 * config_smtp.sample.php — TEMPLATE. Copy to config_smtp.php on the server (that file is git-ignored).
 *
 * config_smtp.php — credentials for sending the Team Summary / Reports
 * emails through an actual mailbox instead of PHP's raw mail() (which most
 * receiving providers, including Google Workspace, silently reject when it
 * comes unauthenticated from shared hosting — it doesn't even land in spam).
 *
 * Your mail is hosted on HOSTINGER, so the mailbox and its password come
 * from hPanel, not Google:
 *   1. Log in to hPanel -> go to "Emails" (left sidebar) -> "Email Accounts".
 *   2. If you don't already have one, click "Create Email Account" and make
 *      a dedicated mailbox on your domain, e.g. noreply@canaresonline.com
 *      or logbook@canaresonline.com -- using a dedicated mailbox (rather
 *      than someone's personal one) means you're not sharing a personal
 *      inbox's password here.
 *   3. Set/note that mailbox's password when you create it (or click the
 *      "..." menu -> "Change Password" on an existing one).
 *   4. Paste the full mailbox address and that password below as
 *      SMTP_USER / SMTP_PASS. Unlike Gmail, Hostinger mailboxes don't need
 *      a separate "app password" -- the regular mailbox password works.
 *   5. SMTP_HOST/SMTP_PORT below (smtp.hostinger.com:587) are already
 *      correct for Hostinger-hosted mail -- no need to change those.
 *
 * After editing this file, purge the LiteSpeed cache from hPanel so the
 * change takes effect.
 */

define('SMTP_HOST', 'smtp.hostinger.com');
define('SMTP_PORT', 587);
define('SMTP_USER', 'noreply@yourdomain.com');   // <-- the sending mailbox, from hPanel > Emails
define('SMTP_PASS', 'CHANGE_ME');            // <-- that mailbox's password, from hPanel > Emails
define('SMTP_FROM_NAME', 'LOGBOOK');