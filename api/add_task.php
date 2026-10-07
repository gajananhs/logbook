<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    ensure_repeat_columns($pdo);

    $b = body();
    $title = trim($b['title'] ?? '');
    $assignedTo = $b['assignedTo'] ?? null;
    $assignedBy = $b['assignedBy'] ?? null;
    if ($title === '' || !$assignedTo || !$assignedBy) respond(['error' => 'Missing required fields'], 400);

    if (!can_assign($pdo, $assignedBy, $assignedTo)) {
        respond(['error' => "You don't have permission to assign tasks to this person"], 403);
    }

    $statusId = $b['statusId'] ?? null;
    if (!$statusId) {
        $row = $pdo->query("SELECT id FROM statuses WHERE is_done = 0 ORDER BY sort_order ASC LIMIT 1")->fetch();
        $statusId = $row ? $row['id'] : null;
    }
    if (!$statusId) respond(['error' => 'No statuses configured'], 400);

    // Repeated Work: Work Type (daily/weekly/monthly) + a start date. The
    // due date is always calculated here, server-side, from those two —
    // never trusted from the client — so it can't drift out of sync with
    // what Work Type actually means.
    $repeatType = $b['repeatType'] ?? 'none';
    if (!in_array($repeatType, ['none', 'daily', 'weekly', 'monthly'], true)) {
        respond(['error' => 'Work Type must be Daily, Weekly or Monthly'], 400);
    }
    $dueDate = ($b['dueDate'] ?? null) ?: null;
    if ($repeatType !== 'none') {
        $startDate = trim($b['startDate'] ?? '');
        if ($startDate === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate)) {
            respond(['error' => 'Pick a start date for the repeated work'], 400);
        }
        $dueDate = add_repeat_interval($startDate, $repeatType);
    }

    $id = uid('t');
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare('INSERT INTO tasks (id, title, description, assigned_to, assigned_by, created_at, due_date, estimated_hours, status, repeat_type)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id, $title, $b['description'] ?? null, $assignedTo, $assignedBy, $now,
        $dueDate, ($b['estimatedHours'] ?? null) ?: null, $statusId, $repeatType
    ]);
    if ($assignedTo !== $assignedBy) {
        notify($pdo, $assignedTo, "New task assigned: $title", $id);
    }
    respond(['id' => $id, 'statusId' => $statusId, 'dueDate' => $dueDate, 'repeatType' => $repeatType]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
