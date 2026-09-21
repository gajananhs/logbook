<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    ensure_repeat_columns($pdo);

    $users = $pdo->query('SELECT id, name, created_at, is_admin, role, department_id, sub_department_id, department, phone, last_seen, last_lat, last_lng, location_at, (pin_hash IS NOT NULL) AS has_pin FROM users ORDER BY created_at ASC')->fetchAll();
    foreach ($users as &$u) {
        $u['has_pin'] = (bool)$u['has_pin'];
        $u['isAdmin'] = (bool)$u['is_admin']; unset($u['is_admin']);
        $u['orgRole'] = $u['role']; unset($u['role']);
        $u['departmentId'] = $u['department_id']; unset($u['department_id']);
        $u['subDepartmentId'] = $u['sub_department_id']; unset($u['sub_department_id']);
        $u['lastSeen'] = $u['last_seen']; unset($u['last_seen']);
        $u['lastLat'] = $u['last_lat'] !== null ? (float)$u['last_lat'] : null; unset($u['last_lat']);
        $u['lastLng'] = $u['last_lng'] !== null ? (float)$u['last_lng'] : null; unset($u['last_lng']);
        $u['locationAt'] = $u['location_at']; unset($u['location_at']);
    }
    unset($u);

    $departments = $pdo->query('SELECT id, name FROM departments ORDER BY name ASC')->fetchAll();
    $subDepartments = $pdo->query('SELECT id, department_id, name FROM sub_departments ORDER BY name ASC')->fetchAll();
    foreach ($subDepartments as &$sd) { $sd['departmentId'] = $sd['department_id']; unset($sd['department_id']); }
    unset($sd);

    $statuses = $pdo->query('SELECT id, name, color, is_done, sort_order FROM statuses ORDER BY sort_order ASC')->fetchAll();
    foreach ($statuses as &$s) { $s['is_done'] = (bool)$s['is_done']; $s['isDone'] = $s['is_done']; unset($s['is_done']); $s['sortOrder'] = (int)$s['sort_order']; unset($s['sort_order']); }
    unset($s);

    $tasks = $pdo->query('SELECT * FROM tasks ORDER BY created_at DESC')->fetchAll();
    $updates = $pdo->query('SELECT * FROM task_updates ORDER BY ts ASC')->fetchAll();

    $updatesByTask = [];
    foreach ($updates as $u) {
        $updatesByTask[$u['task_id']][] = [
            'id' => $u['id'],
            'date' => $u['ts'],
            'progressPct' => (int)$u['progress_pct'],
            'hoursLogged' => $u['hours_logged'] !== null ? (float)$u['hours_logged'] : null,
            'note' => $u['note'],
            'byUserId' => $u['by_user_id'],
        ];
    }

    $out = [];
    foreach ($tasks as $t) {
        $out[] = [
            'id' => $t['id'],
            'title' => $t['title'],
            'description' => $t['description'],
            'assignedTo' => $t['assigned_to'],
            'assignedBy' => $t['assigned_by'],
            'createdAt' => $t['created_at'],
            'dueDate' => $t['due_date'],
            'estimatedHours' => $t['estimated_hours'] !== null ? (float)$t['estimated_hours'] : null,
            'status' => $t['status'],
            'completedAt' => $t['completed_at'],
            'actualHours' => $t['actual_hours'] !== null ? (float)$t['actual_hours'] : null,
            'repeatType' => $t['repeat_type'] ?? 'none',
            'repeatParentId' => $t['repeat_parent_id'] ?? null,
            'updates' => $updatesByTask[$t['id']] ?? [],
        ];
    }

    $attendanceRows = $pdo->query('SELECT * FROM attendance ORDER BY clock_in DESC LIMIT 300')->fetchAll();
    $attendance = [];
    foreach ($attendanceRows as $a) {
        $attendance[] = [
            'id' => $a['id'], 'userId' => $a['user_id'],
            'clockIn' => $a['clock_in'], 'clockOut' => $a['clock_out'],
            'latIn' => $a['lat_in'] !== null ? (float)$a['lat_in'] : null,
            'lngIn' => $a['lng_in'] !== null ? (float)$a['lng_in'] : null,
            'latOut' => $a['lat_out'] !== null ? (float)$a['lat_out'] : null,
            'lngOut' => $a['lng_out'] !== null ? (float)$a['lng_out'] : null,
        ];
    }

    respond(['users' => $users, 'tasks' => $out, 'statuses' => $statuses, 'attendance' => $attendance, 'departments' => $departments, 'subDepartments' => $subDepartments]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}