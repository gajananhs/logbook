<?php
/** POST /api/get_sales_report_link.php — returns a short-lived signed link
 *  that sends the current LOGBOOK user back to SALES REPORTER, already
 *  logged in, matched by name. Mirrors Sales Reporter's own
 *  api/get_logbook_link.php, in reverse.
 *
 *  Logbook has no server-side session (each visit re-identifies by
 *  name/PIN client-side), so — unlike the Sales Reporter version — this
 *  trusts the name the frontend sends and just confirms it matches a real
 *  Logbook account before signing the link.
 */
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $name = trim($b['name'] ?? '');

    if ($name === '') {
        respond(['error' => 'Missing name'], 400);
    }
    if (!defined('SSO_SHARED_SECRET') || SSO_SHARED_SECRET === '' || SSO_SHARED_SECRET === 'CHANGE_ME_LONG_RANDOM_STRING') {
        respond(['error' => 'Single sign-on is not set up yet. Ask your admin to set SSO_SHARED_SECRET in config.php.'], 500);
    }
    if (!defined('SALES_REPORT_URL') || SALES_REPORT_URL === '') {
        respond(['error' => 'Sales Reporter link is not set up yet. Ask your admin to set SALES_REPORT_URL in config.php.'], 500);
    }

    // Confirm this is really a Logbook account, same lookup style as sso_login.php.
    $stmt = $pdo->prepare('SELECT id, name FROM users WHERE LOWER(name) = LOWER(?)');
    $stmt->execute([$name]);
    $user = $stmt->fetch();
    if (!$user) {
        respond(['error' => 'No matching account found'], 404);
    }

    // Only the marketing/sales-side users who actually use Sales Reporter
    // get this handoff — keep this list in sync with SALES_REPORT_USERS
    // in assets/app.js.
    $salesReportUsers = ['mahesh', 'prem', 'mohan raj', 'harishiv', 'gajanan', 'sunitha', 'ramji'];
    if (!in_array(strtolower(trim($user['name'])), $salesReportUsers, true)) {
        respond(['error' => 'This account does not have Sales Reporter access'], 403);
    }

    // Link is valid for 2 minutes and single-purpose (name + expiry only),
    // signed with the exact same shared secret used for the forward handoff.
    $exp = time() + 120;
    $sig = hash_hmac('sha256', $user['name'] . '|' . $exp, SSO_SHARED_SECRET);

    $url = rtrim(SALES_REPORT_URL, '/')
        . '?sso_name=' . rawurlencode($user['name'])
        . '&sso_exp=' . $exp
        . '&sso_sig=' . $sig;

    respond(['ok' => true, 'url' => $url]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}