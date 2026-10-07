<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $updateId = $b['updateId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$updateId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT by_user_id, task_id FROM task_updates WHERE id = ?');
    $stmt->execute([$updateId]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Update not found'], 404);
    if ($row['by_user_id'] !== $requestingUserId) respond(['error' => 'You can only edit your own updates'], 403);

    $progress = max(0, min(100, (int)($b['progressPct'] ?? 0)));
    $stmt = $pdo->prepare('UPDATE task_updates SET progress_pct = ?, hours_logged = ?, note = ? WHERE id = ?');
    $stmt->execute([$progress, ($b['hoursLogged'] ?? null) ?: null, $b['note'] ?? null, $updateId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
