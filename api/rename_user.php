<?php
/**
 * POST /api/rename_user.php — Admin only.
 * Renames an existing employee. This is a plain UPDATE on users.name by
 * the unchanged id — every other table (tasks, task_updates, attendance,
 * notifications, reports) references users only by id, never by name, so
 * nothing already recorded for this employee is affected. history, past
 * reports, task assignments, attendance — all stay exactly as they were.
 */
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $targetUserId     = $b['targetUserId'] ?? null;
    $requestingUserId = $b['requestingUserId'] ?? null;
    $newName          = trim($b['newName'] ?? '');

    if (!$targetUserId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);
    if ($newName === '') respond(['error' => 'Name cannot be empty'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can rename an employee'], 403);

    $stmt = $pdo->prepare('SELECT id, name FROM users WHERE id = ?');
    $stmt->execute([$targetUserId]);
    $target = $stmt->fetch();
    if (!$target) respond(['error' => 'Employee not found'], 404);

    if ($target['name'] === $newName) {
        respond(['ok' => true, 'id' => $targetUserId, 'name' => $newName]); // no-op, nothing to do
    }

    // Same-name check, case-insensitive — matches how login/SSO already
    // look up users (LOWER(name) = LOWER(?)) elsewhere in this app, and
    // the table's own UNIQUE KEY uniq_name would reject it either way.
    $stmt = $pdo->prepare('SELECT id FROM users WHERE LOWER(name) = LOWER(?) AND id != ?');
    $stmt->execute([$newName, $targetUserId]);
    if ($stmt->fetch()) {
        respond(['error' => 'Another employee is already named "' . $newName . '"'], 409);
    }

    try {
        $pdo->prepare('UPDATE users SET name = ? WHERE id = ?')->execute([$newName, $targetUserId]);
    } catch (PDOException $e) {
        // Race condition on the UNIQUE KEY — extremely unlikely given the
        // check above, but fail with the same friendly message either way.
        if ((int)$e->getCode() === 23000 || strpos($e->getMessage(), 'uniq_name') !== false) {
            respond(['error' => 'Another employee is already named "' . $newName . '"'], 409);
        }
        throw $e;
    }

    respond(['ok' => true, 'id' => $targetUserId, 'name' => $newName]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
