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

    $stmt = $pdo->prepare('SELECT id FROM attendance WHERE user_id = ? AND clock_out IS NULL LIMIT 1');
    $stmt->execute([$userId]);
    if ($stmt->fetch()) respond(['error' => 'Already clocked in'], 400);

    $id = uid('att');
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare('INSERT INTO attendance (id, user_id, clock_in, lat_in, lng_in) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$id, $userId, $now, $b['lat'] ?? null, $b['lng'] ?? null]);
    respond(['id' => $id, 'clockIn' => $now]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
