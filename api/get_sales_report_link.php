<?php
/** POST /api/get_sales_report_link.php — returns a short-lived signed link that
 *  sends the signed-in Logbook user back to Sales Reporter, already logged in.
 *  Mirror of Sales Reporter's api/get_logbook_link.php.
 *
 *  The caller must send the session token Logbook issued at sign-in
 *  (login.php / sso_login.php). The person is taken from that token, never
 *  from a name in the request, so nobody can obtain a Sales Reporter link
 *  for someone else. Sales Reporter then checks the link (signature, expiry)
 *  and only signs in a matching Sales Reporter account — anyone outside the
 *  Sales Reporter team is refused there. */
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    if (!sso_configured()) {
        respond(['error' => 'Single sign-on is not set up yet. Ask your admin to set SSO_SHARED_SECRET in config.php.'], 500);
    }
    if (!defined('SALES_REPORT_URL') || SALES_REPORT_URL === '') {
        respond(['error' => 'Sales Reporter link is not set up yet. Ask your admin to set SALES_REPORT_URL in config.php.'], 500);
    }
    $b = body();
    $session = verify_session_token((string)($b['token'] ?? ''));
    if (!$session) {
        respond(['error' => 'Your Logbook sign-in has expired — sign in again.'], 401);
    }

    $pdo = get_db();
    $stmt = $pdo->prepare('SELECT id, name FROM users WHERE id = ?');
    $stmt->execute([$session['u']]);
    $user = $stmt->fetch();
    if (!$user) {
        respond(['error' => 'No matching account found'], 404);
    }

    // Valid for 2 minutes, name + expiry only, same shared secret as the forward hand-off.
    $exp = time() + 120;
    $sig = hash_hmac('sha256', $user['name'] . '|' . $exp, SSO_SHARED_SECRET);
    $base = SALES_REPORT_URL;
    $url = $base . (strpos($base, '?') === false ? '?' : '&')
        . 'sso_name=' . rawurlencode($user['name'])
        . '&sso_exp=' . $exp
        . '&sso_sig=' . $sig;

    respond(['ok' => true, 'url' => $url]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
