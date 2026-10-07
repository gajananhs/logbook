<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    ensure_repeat_columns($pdo);

    $b = body();
    $taskId = $b['taskId'] ?? null;
    $statusId = $b['statusId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$taskId || !$statusId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT assigned_to, assigned_by FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $task = $stmt->fetch();
    if (!$task) respond(['error' => 'Task not found'], 404);
    if ($requestingUserId !== $task['assigned_to'] && $requestingUserId !== $task['assigned_by']) {
        respond(['error' => 'Only the assignee or assigner can change status'], 403);
    }

    $stmt = $pdo->prepare('SELECT is_done FROM statuses WHERE id = ?');
    $stmt->execute([$statusId]);
    $statusRow = $stmt->fetch();
    if (!$statusRow) respond(['error' => 'Status not found'], 404);

    if ((int)$statusRow['is_done'] === 1) {
        $stmt = $pdo->prepare('SELECT COALESCE(SUM(hours_logged),0) AS total FROM task_updates WHERE task_id = ?');
        $stmt->execute([$taskId]);
        $loggedHours = (float)$stmt->fetch()['total'];
        $stmt = $pdo->prepare('SELECT estimated_hours, title FROM tasks WHERE id = ?');
        $stmt->execute([$taskId]);
        $estRow = $stmt->fetch();
        $actual = $loggedHours ?: ($estRow['estimated_hours'] ?? null);
        $now = date('Y-m-d H:i:s');
        $stmt = $pdo->prepare('UPDATE tasks SET status = ?, completed_at = ?, actual_hours = ? WHERE id = ?');
        $stmt->execute([$statusId, $now, $actual, $taskId]);
        if ($requestingUserId === $task['assigned_to'] && $task['assigned_by'] !== $task['assigned_to']) {
            notify($pdo, $task['assigned_by'], "Task completed: " . ($estRow['title'] ?? ''), $taskId);
        }
        $nextOccurrenceId = spawn_next_occurrence($pdo, $taskId);
        respond(['ok' => true, 'completedAt' => $now, 'actualHours' => $actual, 'nextOccurrenceId' => $nextOccurrenceId]);
    } else {
        $stmt = $pdo->prepare('UPDATE tasks SET status = ?, completed_at = NULL, actual_hours = NULL WHERE id = ?');
        $stmt->execute([$statusId, $taskId]);
        respond(['ok' => true, 'completedAt' => null, 'actualHours' => null]);
    }
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
