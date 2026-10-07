<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $userId = $b['userId'] ?? null;
    $pin = $b['pin'] ?? '';
    if (!$userId) respond(['error' => 'Missing userId'], 400);

    $stmt = $pdo->prepare('SELECT pin_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'User not found'], 404);

    if ($row['pin_hash'] === null) respond(['ok' => true]);
    respond(['ok' => password_verify((string)$pin, $row['pin_hash'])]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
