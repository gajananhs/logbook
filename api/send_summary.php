<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    $b = body();
    $requestingUserId = $b['requestingUserId'] ?? null;
    if (!$requestingUserId) respond(['error' => 'Missing requestingUserId'], 400);

    $stmt = $pdo->prepare('SELECT is_admin, name FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can send the summary'], 403);

    $result = send_team_summary_email($pdo, 'sent by ' . $requester['name']);
    if (isset($result['error'])) respond($result, 500);
    respond($result);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
