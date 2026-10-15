<?php
/**
 * POST /api/renew_task.php
 * Manually generates the next occurrence of a repeating task — for
 * renewing a Daily/Weekly/Monthly repeated task's schedule without
 * necessarily marking the current occurrence complete first (e.g. it's
 * being skipped, or the cadence needs to move forward regardless).
 * Only the assignee or assigner can renew, same as changing status.
 */
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    ensure_repeat_columns($pdo);

    $b = body();
    $taskId = $b['taskId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$taskId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT assigned_to, assigned_by, repeat_type, title FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $task = $stmt->fetch();
    if (!$task) respond(['error' => 'Task not found'], 404);
    if ($requestingUserId !== $task['assigned_to'] && $requestingUserId !== $task['assigned_by']) {
        respond(['error' => 'Only the assignee or assigner can renew this task'], 403);
    }
    if (empty($task['repeat_type']) || $task['repeat_type'] === 'none') {
        respond(['error' => 'This task isn\'t set up as repeated work'], 400);
    }

    $newId = spawn_next_occurrence($pdo, $taskId);
    if (!$newId) {
        respond(['error' => 'Could not renew — no open status is configured to put the new occurrence into'], 400);
    }

    $stmt = $pdo->prepare('SELECT due_date FROM tasks WHERE id = ?');
    $stmt->execute([$newId]);
    $newDue = $stmt->fetch()['due_date'];

    respond(['ok' => true, 'newTaskId' => $newId, 'dueDate' => $newDue]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
