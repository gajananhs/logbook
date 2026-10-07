<?php
/** POST /api/sso_login.php — logs a user in via a signed link from Sales
 *  Reporter instead of a name+PIN form. Matches the same user by name and
 *  returns the exact same shape as login.php so the frontend can reuse
 *  enterAsUser() unchanged. */
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

    if ($name === '' || $exp === '' || $sig === '') {
        respond(['error' => 'Bad handoff link'], 400);
    }
    if (!defined('SSO_SHARED_SECRET') || SSO_SHARED_SECRET === '' || SSO_SHARED_SECRET === 'CHANGE_ME_LONG_RANDOM_STRING') {
        respond(['error' => 'Single sign-on is not set up yet. Ask your admin to set SSO_SHARED_SECRET in config.php.'], 500);
    }
    if ((int)$exp < time()) {
        respond(['error' => 'This link has expired — go back to Sales Reporter and click Logbook again'], 401);
    }

    // Constant-time compare so a mismatched signature can't be timed/guessed.
    $expected = hash_hmac('sha256', $name . '|' . $exp, SSO_SHARED_SECRET);
    if (!hash_equals($expected, $sig)) {
        respond(['error' => 'Invalid handoff link'], 401);
    }

    // Same lookup as the normal login form — matched by name, case-insensitive.
    $stmt = $pdo->prepare(
        'SELECT id, name, created_at, is_admin, role, department_id, sub_department_id, department, phone, pin_hash
         FROM users WHERE LOWER(name) = LOWER(?)'
    );
    $stmt->execute([$name]);
    $user = $stmt->fetch();

    if (!$user) {
        respond(['error' => 'No Logbook account found for "' . $name . '" — ask your admin to add you here first'], 404);
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
    ]]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
