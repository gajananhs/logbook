<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $userId = $b['userId'] ?? null;
    if (!$userId) respond(['error' => 'Missing userId'], 400);
    $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')->execute([$userId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
