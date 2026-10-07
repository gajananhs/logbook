<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $name = trim($b['name'] ?? '');
    $requestingUserId = $b['requestingUserId'] ?? null;
    if ($name === '' || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can add a department'], 403);

    $id = uid('dept');
    try {
        $pdo->prepare('INSERT INTO departments (id, name) VALUES (?, ?)')->execute([$id, $name]);
    } catch (PDOException $e) {
        respond(['error' => 'A department with that name already exists'], 400);
    }
    respond(['department' => ['id' => $id, 'name' => $name]]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
