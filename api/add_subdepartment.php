<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();

    $requestingUserId = $b['requestingUserId'] ?? null;
    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can create sub-departments'], 403);

    $name = trim($b['name'] ?? '');
    $departmentId = $b['departmentId'] ?? null;
    if ($name === '' || !$departmentId) respond(['error' => 'Name and department are required'], 400);

    $stmt = $pdo->prepare('SELECT id FROM departments WHERE id = ?');
    $stmt->execute([$departmentId]);
    if (!$stmt->fetch()) respond(['error' => 'Department not found'], 404);

    $stmt = $pdo->prepare('SELECT id, department_id, name, head_user_id, created_at FROM sub_departments WHERE department_id = ? AND name = ?');
    $stmt->execute([$departmentId, $name]);
    $existing = $stmt->fetch();
    if ($existing) {
        respond(['subDepartment' => ['id' => $existing['id'], 'departmentId' => $existing['department_id'], 'name' => $existing['name'], 'headUserId' => $existing['head_user_id'], 'created_at' => $existing['created_at']]]);
    }

    $id = uid('sd');
    $now = date('Y-m-d H:i:s');
    $pdo->prepare('INSERT INTO sub_departments (id, department_id, name, head_user_id, created_at) VALUES (?, ?, ?, NULL, ?)')->execute([$id, $departmentId, $name, $now]);
    respond(['subDepartment' => ['id' => $id, 'departmentId' => $departmentId, 'name' => $name, 'headUserId' => null, 'created_at' => $now]]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
