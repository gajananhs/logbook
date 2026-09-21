<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $subDepartmentId = $b['subDepartmentId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$subDepartmentId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can delete a sub-department'], 403);

    $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM users WHERE sub_department_id = ?');
    $stmt->execute([$subDepartmentId]);
    if ((int)$stmt->fetch()['c'] > 0) respond(['error' => 'Reassign employees off this sub-department first'], 400);

    $pdo->prepare('DELETE FROM sub_departments WHERE id = ?')->execute([$subDepartmentId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
