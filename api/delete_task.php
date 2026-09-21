<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $taskId = $b['taskId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$taskId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT assigned_by FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Task not found'], 404);
    if ($row['assigned_by'] !== $requestingUserId) respond(['error' => 'Only the assigner can delete this task'], 403);

    $pdo->prepare('DELETE FROM tasks WHERE id = ?')->execute([$taskId]);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
