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

    $stmt = $pdo->prepare('SELECT id FROM attendance WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Not currently clocked in'], 400);

    $now = date('Y-m-d H:i:s');
    $pdo->prepare('UPDATE attendance SET clock_out = ?, lat_out = ?, lng_out = ? WHERE id = ?')
        ->execute([$now, $b['lat'] ?? null, $b['lng'] ?? null, $row['id']]);
    respond(['id' => $row['id'], 'clockOut' => $now]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
