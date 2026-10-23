<?php
/** POST /api/sso_login.php — signs a Sales Reporter team member into Logbook
 *  from the signed hand-off link Sales Reporter creates (api/get_logbook_link.php
 *  there). Sales Reporter only issues that link to a member logged in to Sales
 *  Reporter, so a valid signature is the proof of team membership.
 *  Checks, all on the server:
 *    1. signature   HMAC-SHA256(name|exp) with SSO_SHARED_SECRET (constant-time)
 *    2. expiry      the link is valid for 2 minutes
 *    3. single use  a link that has been used once is refused (sso_used_tickets)
 *    4. account     a Logbook account with that name must exist
 *  Returns the same shape as login.php, plus a session token and
 *  viaSalesReport so the app shows "Back to Sales Report". */
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $name = trim($b['name'] ?? '');
    $exp  = (string)($b['exp'] ?? '');
    $sig  = (string)($b['sig'] ?? '');

    if ($name === '' || $exp === '' || $sig === '' || !ctype_digit($exp)) {
        respond(['error' => 'Bad hand-off link'], 400);
    }
    if (!sso_configured()) {
        respond(['error' => 'Single sign-on is not set up yet. Ask your admin to set SSO_SHARED_SECRET in config.php.'], 500);
    }
    $expected = hash_hmac('sha256', $name . '|' . $exp, SSO_SHARED_SECRET);
    if (!hash_equals($expected, $sig)) {
        respond(['error' => 'Access denied — this link is not valid. Open Logbook from Sales Reporter.'], 401);
    }
    if ((int)$exp < time()) {
        respond(['error' => 'This link has expired — go back to Sales Reporter and tap Logbook again.'], 401);
    }
    if (!claim_sso_ticket($pdo, $sig, (int)$exp)) {
        respond(['error' => 'This link has already been used — go back to Sales Reporter and tap Logbook again.'], 401);
    }

    // Same lookup as the normal login form — matched by name, case-insensitive.
    $stmt = $pdo->prepare(
        'SELECT id, name, created_at, is_admin, role, department_id, sub_department_id, department, phone, pin_hash
         FROM users WHERE LOWER(name) = LOWER(?)'
    );
    $stmt->execute([$name]);
    $user = $stmt->fetch();

    if (!$user) {
        respond(['error' => 'No Logbook account found for "' . $name . '" — ask your admin to add you on the Employees page first.'], 403);
    }

    respond(['ok' => true, 'user' => [
        'id' => $user['id'],
        'name' => $user['name'],
        'created_at' => $user['created_at'],
        'isAdmin' => (bool)$user['is_admin'],
        'orgRole' => $user['role'],
        'departmentId' => $user['department_id'],
        'subDepartmentId' => $user['sub_department_id'],
        'department' => $user['department'],
        'phone' => $user['phone'],
        'has_pin' => $user['pin_hash'] !== null,
        'viaSalesReport' => true,
    ], 'token' => issue_session_token($user['id'], true)]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
