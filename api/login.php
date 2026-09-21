<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $name = trim($b['name'] ?? '');
    $pin = trim($b['pin'] ?? '');
    if ($name === '') respond(['error' => 'Enter your name'], 400);

    // The login screen no longer lists employees (that leaked the whole
    // roster to anyone who opened the URL) and no longer self-registers --
    // an admin has to add the person first via the Employees tab.
    // Explicit LOWER() comparison, not relying on the table's collation to be
    // case-insensitive — "Sunitha" and "sunitha" must both work regardless of
    // how the live table happens to be configured.
    $stmt = $pdo->prepare(
        'SELECT id, name, created_at, is_admin, role, department_id, sub_department_id, department, phone, pin_hash
         FROM users WHERE LOWER(name) = LOWER(?)'
    );
    $stmt->execute([$name]);
    $user = $stmt->fetch();

    if (!$user) {
        respond(['error' => 'No employee found with that name — ask your admin to add you'], 404);
    }

    if ($user['pin_hash'] !== null) {
        if ($pin === '' || !password_verify($pin, $user['pin_hash'])) {
            respond(['error' => 'Incorrect PIN'], 403);
        }
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
