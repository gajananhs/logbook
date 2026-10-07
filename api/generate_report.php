<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $type = $b['type'] ?? 'task_summary';
    $rangeStart = $b['rangeStart'] ?? null;
    $rangeEnd = $b['rangeEnd'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$requestingUserId) respond(['error' => 'Missing requestingUserId'], 400);

    $stmt = $pdo->prepare('SELECT is_admin, name FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can generate reports'], 403);

    $users = $pdo->query('SELECT id, name FROM users')->fetchAll();
    $reportData = ['type' => $type, 'rangeStart' => $rangeStart, 'rangeEnd' => $rangeEnd, 'rows' => []];

    if ($type === 'attendance_summary') {
        foreach ($users as $u) {
            $sql = 'SELECT COALESCE(SUM(TIMESTAMPDIFF(MINUTE, clock_in, COALESCE(clock_out, NOW()))),0) AS mins, COUNT(*) AS shifts
                    FROM attendance WHERE user_id = ?';
            $params = [$u['id']];
            if ($rangeStart) { $sql .= ' AND clock_in >= ?'; $params[] = $rangeStart . ' 00:00:00'; }
            if ($rangeEnd) { $sql .= ' AND clock_in <= ?'; $params[] = $rangeEnd . ' 23:59:59'; }
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $row = $stmt->fetch();
            $reportData['rows'][] = [
                'userId' => $u['id'], 'name' => $u['name'],
                'shifts' => (int)$row['shifts'], 'hours' => round(((int)$row['mins']) / 60, 2),
            ];
        }
    } else { // task_summary
        foreach ($users as $u) {
            $sql = 'SELECT COUNT(*) AS assigned,
                           SUM(CASE WHEN t.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
                           AVG(CASE WHEN t.completed_at IS NOT NULL AND t.estimated_hours IS NOT NULL AND t.actual_hours IS NOT NULL AND t.actual_hours > 0
                               THEN LEAST(150, (t.estimated_hours / t.actual_hours) * 100) END) AS avg_eff
                    FROM tasks t WHERE t.assigned_to = ?';
            $params = [$u['id']];
            if ($rangeStart) { $sql .= ' AND t.created_at >= ?'; $params[] = $rangeStart . ' 00:00:00'; }
            if ($rangeEnd) { $sql .= ' AND t.created_at <= ?'; $params[] = $rangeEnd . ' 23:59:59'; }
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $row = $stmt->fetch();
            $reportData['rows'][] = [
                'userId' => $u['id'], 'name' => $u['name'],
                'assigned' => (int)$row['assigned'], 'completed' => (int)($row['completed'] ?? 0),
                'avgEfficiency' => $row['avg_eff'] !== null ? round((float)$row['avg_eff']) : null,
            ];
        }
    }

    $id = uid('rep');
    $now = date('Y-m-d H:i:s');
    $pdo->prepare('INSERT INTO reports (id, generated_by, type, range_start, range_end, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        ->execute([$id, $requestingUserId, $type, $rangeStart ?: null, $rangeEnd ?: null, json_encode($reportData), $now]);

    // Saving a report always also emails it to the fixed recipient list —
    // "Save" means "saved + emailed" in one action. A failed/unavailable
    // email must never fail the save itself, so this is best-effort.
    $emailResult = send_report_email($pdo, $reportData, $requester['name'] ?? 'admin');

    $response = ['id' => $id, 'createdAt' => $now, 'data' => $reportData];
    if (isset($emailResult['ok'])) {
        $response['emailedTo'] = $emailResult['sentTo'];
    } else {
        $response['emailError'] = $emailResult['error'] ?? 'Could not send email';
    }

    respond($response);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}