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
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$taskId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT assigned_by FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Task not found'], 404);
    if ($row['assigned_by'] !== $requestingUserId) respond(['error' => 'Only the assigner can edit this task'], 403);

    $title = trim($b['title'] ?? '');
    if ($title === '') respond(['error' => 'Title required'], 400);

    $newAssignedTo = $b['assignedTo'] ?? null;
    if ($newAssignedTo && !can_assign($pdo, $requestingUserId, $newAssignedTo)) {
        respond(['error' => "You don't have permission to assign tasks to this person"], 403);
    }

    // Repeat settings are optional on an edit — only touched if the client
    // sent repeatType at all, so a plain title/due-date edit never
    // accidentally clears an existing repeat schedule.
    $dueDate = ($b['dueDate'] ?? null) ?: null;
    $repeatUpdate = '';
    $params = [
        $title, $b['description'] ?? null, $newAssignedTo,
        $dueDate, ($b['estimatedHours'] ?? null) ?: null,
    ];
    if (array_key_exists('repeatType', $b)) {
        $repeatType = $b['repeatType'];
        if (!in_array($repeatType, ['none', 'daily', 'weekly', 'monthly'], true)) {
            respond(['error' => 'Work Type must be Daily, Weekly or Monthly'], 400);
        }
        // A start date is only needed to RECALCULATE the due date (e.g.
        // turning repeat on for the first time, or deliberately resetting
        // the cadence). If it's omitted, the due date already carried
        // through from the edit form's own field is left untouched —
        // this lets Work Type be changed without silently advancing the
        // due date by an extra interval.
        if ($repeatType !== 'none' && !empty($b['startDate'])) {
            $startDate = trim($b['startDate']);
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate)) {
                respond(['error' => 'Start date must be a valid date'], 400);
            }
            $dueDate = add_repeat_interval($startDate, $repeatType);
            $params[3] = $dueDate;
        }
        $repeatUpdate = ', repeat_type = ?';
        $params[] = $repeatType;
    }
    $params[] = $taskId;

    $stmt = $pdo->prepare('UPDATE tasks SET title = ?, description = ?, assigned_to = ?, due_date = ?, estimated_hours = ?' . $repeatUpdate . ' WHERE id = ?');
    $stmt->execute($params);
    respond(['ok' => true, 'dueDate' => $dueDate]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
