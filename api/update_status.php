<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $statusId = $b['statusId'] ?? null;
    $name = trim($b['name'] ?? '');
    $color = trim($b['color'] ?? '');
    if (!$statusId || $name === '' || !preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) respond(['error' => 'Missing or invalid fields'], 400);

    $isDone = !empty($b['isDone']) ? 1 : 0;
    $stmt = $pdo->prepare('UPDATE statuses SET name = ?, color = ?, is_done = ? WHERE id = ?');
    $stmt->execute([$name, $color, $isDone, $statusId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
