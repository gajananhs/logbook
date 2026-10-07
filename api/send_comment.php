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
    $message = trim($b['message'] ?? '');
    if (!$targetUserId || !$requestingUserId || $message === '') respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT is_admin, role, department_id, sub_department_id FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester) respond(['error' => 'Requester not found'], 404);

    $stmt->execute([$targetUserId]);
    $target = $stmt->fetch();
    if (!$target) respond(['error' => 'Employee not found'], 404);

    // Same visibility rule as Team Board: admin sees everyone, a dept head can
    // comment on anyone in their department, a sub head only their own
    // sub-department, and anyone can leave themselves a note.
    $allowed = false;
    if ($requester['is_admin']) $allowed = true;
    elseif ($requester['role'] === 'dept_head' && $requester['department_id'] !== null && $target['department_id'] === $requester['department_id']) $allowed = true;
    elseif ($requester['role'] === 'sub_head' && $requester['sub_department_id'] !== null && $target['sub_department_id'] === $requester['sub_department_id']) $allowed = true;
    elseif ($targetUserId === $requestingUserId) $allowed = true;

    if (!$allowed) respond(['error' => "You don't have permission to comment on this employee"], 403);

    $stmt = $pdo->prepare('SELECT name FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requesterName = $stmt->fetchColumn();

    notify($pdo, $targetUserId, "{$requesterName} commented: {$message}", null);
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
