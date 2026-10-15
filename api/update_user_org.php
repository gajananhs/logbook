<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $targetUserId = $b['targetUserId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    $orgRole = $b['orgRole'] ?? 'employee';
    $departmentId = $b['departmentId'] ?? null;
    $subDepartmentId = $b['subDepartmentId'] ?? null;
    if (!$targetUserId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);
    if (!in_array($orgRole, ['employee', 'sub_head', 'dept_head'], true)) respond(['error' => 'Invalid role'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => "Only an admin can change an employee's role"], 403);

    if ($orgRole === 'dept_head') {
        if (!$departmentId) respond(['error' => 'Pick a department for a department head'], 400);
        $subDepartmentId = null;
    } elseif ($orgRole === 'sub_head') {
        if (!$subDepartmentId) respond(['error' => 'Pick a sub-department for a sub-department head'], 400);
        $stmt = $pdo->prepare('SELECT department_id FROM sub_departments WHERE id = ?');
        $stmt->execute([$subDepartmentId]);
        $sd = $stmt->fetch();
        if (!$sd) respond(['error' => 'Sub-department not found'], 404);
        $departmentId = $sd['department_id']; // always derive the parent department, don't trust the client's copy
    } else { // employee
        if ($subDepartmentId) {
            $stmt = $pdo->prepare('SELECT department_id FROM sub_departments WHERE id = ?');
            $stmt->execute([$subDepartmentId]);
            $sd = $stmt->fetch();
            if (!$sd) respond(['error' => 'Sub-department not found'], 404);
            $departmentId = $sd['department_id'];
        }
    }

    $stmt = $pdo->prepare('UPDATE users SET role = ?, department_id = ?, sub_department_id = ? WHERE id = ?');
    $stmt->execute([$orgRole, $departmentId ?: null, $subDepartmentId ?: null, $targetUserId]);
    respond(['ok' => true, 'orgRole' => $orgRole, 'departmentId' => $departmentId ?: null, 'subDepartmentId' => $subDepartmentId ?: null]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
