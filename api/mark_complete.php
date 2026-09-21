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
    if (!$taskId) respond(['error' => 'Missing taskId'], 400);

    $doneStatus = $pdo->query("SELECT id FROM statuses WHERE is_done = 1 ORDER BY sort_order ASC LIMIT 1")->fetch();
    if (!$doneStatus) respond(['error' => 'No status is marked as done — set one up first'], 400);

    $stmt = $pdo->prepare('SELECT COALESCE(SUM(hours_logged),0) AS total FROM task_updates WHERE task_id = ?');
    $stmt->execute([$taskId]);
    $loggedHours = (float)$stmt->fetch()['total'];

    // Allow filling in an estimate at completion time if the task never had one --
    // without this, efficiency can never be computed for tasks created without
    // an upfront estimate, even after marking them done.
    if (!empty($b['estimatedHours'])) {
        $pdo->prepare('UPDATE tasks SET estimated_hours = COALESCE(estimated_hours, ?) WHERE id = ?')
            ->execute([$b['estimatedHours'], $taskId]);
    }

    $stmt = $pdo->prepare('SELECT estimated_hours FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $row = $stmt->fetch();
    $actual = ($b['actualHours'] ?? null) ?: ($loggedHours ?: ($row['estimated_hours'] ?? null));

    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare("UPDATE tasks SET status = ?, completed_at = ?, actual_hours = ? WHERE id = ?");
    $stmt->execute([$doneStatus['id'], $now, $actual, $taskId]);
    $stmt = $pdo->prepare('SELECT title, assigned_by, assigned_to FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $t = $stmt->fetch();
    if ($t && $t['assigned_by'] !== $t['assigned_to']) {
        notify($pdo, $t['assigned_by'], "Task completed: " . $t['title'], $taskId);
    }
    $nextOccurrenceId = spawn_next_occurrence($pdo, $taskId);
    respond(['completedAt' => $now, 'actualHours' => $actual, 'statusId' => $doneStatus['id'], 'estimatedHours' => $row['estimated_hours'] !== null ? (float)$row['estimated_hours'] : null, 'nextOccurrenceId' => $nextOccurrenceId]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
