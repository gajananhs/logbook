<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $userId = $_GET['userId'] ?? null;
    if (!$userId) respond(['error' => 'Missing userId'], 400);
    $stmt = $pdo->prepare('SELECT id, message, task_id, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50');
    $stmt->execute([$userId]);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['taskId'] = $r['task_id']; unset($r['task_id']);
        $r['isRead'] = (bool)$r['is_read']; unset($r['is_read']);
        $r['createdAt'] = $r['created_at']; unset($r['created_at']);
    }
    unset($r);
    respond(['notifications' => $rows]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
