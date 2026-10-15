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
    $makeAdmin = !empty($b['isAdmin']) ? 1 : 0;
    if (!$targetUserId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can change admin status'], 403);

    $pdo->prepare('UPDATE users SET is_admin = ? WHERE id = ?')->execute([$makeAdmin, $targetUserId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
