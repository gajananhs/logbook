<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $name = trim($b['name'] ?? '');
    if ($name === '') respond(['error' => 'Name required'], 400);
    $pin = trim($b['pin'] ?? '');
    if ($pin !== '' && !preg_match('/^\d{4}$/', $pin)) respond(['error' => 'PIN must be 4 digits'], 400);
    $department = trim($b['department'] ?? '') ?: null;
    $phone = trim($b['phone'] ?? '') ?: null;

    $stmt = $pdo->prepare('SELECT id, name, created_at, is_admin, department, phone, (pin_hash IS NOT NULL) AS has_pin FROM users WHERE name = ?');
    $stmt->execute([$name]);
    $existing = $stmt->fetch();
    if ($existing) {
        $existing['has_pin'] = (bool)$existing['has_pin'];
        $existing['isAdmin'] = (bool)$existing['is_admin']; unset($existing['is_admin']);
        respond(['user' => $existing]);
    }

    // First employee ever created becomes admin, so someone can manage the rest.
    $countRow = $pdo->query('SELECT COUNT(*) AS c FROM users')->fetch();
    $isFirstUser = ((int)$countRow['c']) === 0;

    $id = uid('u');
    $now = date('Y-m-d H:i:s');
    $pinHash = $pin !== '' ? password_hash($pin, PASSWORD_DEFAULT) : null;
    $stmt = $pdo->prepare('INSERT INTO users (id, name, pin_hash, is_admin, department, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$id, $name, $pinHash, $isFirstUser ? 1 : 0, $department, $phone, $now]);
    respond(['user' => [
        'id' => $id, 'name' => $name, 'created_at' => $now, 'has_pin' => $pinHash !== null,
        'isAdmin' => $isFirstUser, 'department' => $department, 'phone' => $phone,
    ]]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
