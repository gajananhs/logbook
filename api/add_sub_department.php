<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $name = trim($b['name'] ?? '');
    $departmentId = $b['departmentId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if ($name === '' || !$departmentId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can add a sub-department'], 403);

    $stmt = $pdo->prepare('SELECT id FROM departments WHERE id = ?');
    $stmt->execute([$departmentId]);
    if (!$stmt->fetch()) respond(['error' => 'Department not found'], 404);

    $id = uid('sd');
    try {
        $pdo->prepare('INSERT INTO sub_departments (id, department_id, name) VALUES (?, ?, ?)')->execute([$id, $departmentId, $name]);
    } catch (PDOException $e) {
        respond(['error' => 'A sub-department with that name already exists in this department'], 400);
    }
    respond(['subDepartment' => ['id' => $id, 'departmentId' => $departmentId, 'name' => $name]]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
