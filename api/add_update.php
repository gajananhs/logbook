<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $taskId = $b['taskId'] ?? null;
    $byUserId = $b['byUserId'] ?? null;
    $progress = max(0, min(100, (int)($b['progressPct'] ?? 0)));
    if (!$taskId || !$byUserId) respond(['error' => 'Missing required fields'], 400);

    $id = uid('up');
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare('INSERT INTO task_updates (id, task_id, ts, progress_pct, hours_logged, note, by_user_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$id, $taskId, $now, $progress, ($b['hoursLogged'] ?? null) ?: null, $b['note'] ?? null, $byUserId]);

    $stmt = $pdo->prepare('SELECT title, assigned_by, assigned_to FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $task = $stmt->fetch();
    if ($task && $byUserId === $task['assigned_to'] && $task['assigned_by'] !== $task['assigned_to']) {
        notify($pdo, $task['assigned_by'], "Update logged ($progress%) on: " . $task['title'], $taskId);
    }

    respond(['id' => $id, 'date' => $now]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
