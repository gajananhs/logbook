<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $targetUserId = $b['targetUserId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    $newPin = trim($b['newPin'] ?? '');
    if (!$targetUserId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);
    if ($newPin !== '' && !preg_match('/^\d{4}$/', $newPin)) respond(['error' => 'PIN must be 4 digits'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can reset a PIN'], 403);

    $pinHash = $newPin !== '' ? password_hash($newPin, PASSWORD_DEFAULT) : null;
    $pdo->prepare('UPDATE users SET pin_hash = ? WHERE id = ?')->execute([$pinHash, $targetUserId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
