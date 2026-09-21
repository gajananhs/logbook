<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $statusId = $b['statusId'] ?? null;
    if (!$statusId) respond(['error' => 'Missing statusId'], 400);

    $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM tasks WHERE status = ?');
    $stmt->execute([$statusId]);
    if ((int)$stmt->fetch()['c'] > 0) respond(['error' => 'Reassign tasks off this status before deleting it'], 400);

    $pdo->prepare('DELETE FROM statuses WHERE id = ?')->execute([$statusId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
