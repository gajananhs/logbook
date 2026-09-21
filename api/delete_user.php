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
    if (!$targetUserId || !$requestingUserId) respond(['error' => 'Missing required fields'], 400);

    $stmt = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([$requestingUserId]);
    $requester = $stmt->fetch();
    if (!$requester || !$requester['is_admin']) respond(['error' => 'Only an admin can remove an employee'], 403);

    if ($targetUserId === $requestingUserId) respond(['error' => "You can't remove your own account while signed in as it"], 400);

    $stmt = $pdo->prepare('SELECT is_admin, name FROM users WHERE id = ?');
    $stmt->execute([$targetUserId]);
    $target = $stmt->fetch();
    if (!$target) respond(['error' => 'Employee not found'], 404);

    if ($target['is_admin']) {
        $countRow = $pdo->query('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1')->fetch();
        if ((int)$countRow['c'] <= 1) respond(['error' => 'Cannot remove the last remaining admin'], 400);
    }

    $force = !empty($b['force']);

    // Notifications carry no lasting record value — safe to clear so they don't block deletion.
    $pdo->prepare('DELETE FROM notifications WHERE user_id = ?')->execute([$targetUserId]);

    if ($force) {
        // Admin explicitly confirmed a second time (see assets/app.js) that they want to
        // permanently wipe this employee's task/attendance/report history along with them.
        $pdo->beginTransaction();
        try {
            $pdo->prepare('UPDATE sub_departments SET head_user_id = NULL WHERE head_user_id = ?')->execute([$targetUserId]);
            $pdo->prepare('DELETE FROM task_updates WHERE by_user_id = ?')->execute([$targetUserId]);
            $pdo->prepare('DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE assigned_to = ? OR assigned_by = ?)')
                ->execute([$targetUserId, $targetUserId]);
            $pdo->prepare('DELETE FROM tasks WHERE assigned_to = ? OR assigned_by = ?')->execute([$targetUserId, $targetUserId]);
            $pdo->prepare('DELETE FROM attendance WHERE user_id = ?')->execute([$targetUserId]);
            $pdo->prepare('DELETE FROM reports WHERE generated_by = ?')->execute([$targetUserId]);
            $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$targetUserId]);
            $pdo->commit();
        } catch (Exception $e) {
            $pdo->rollBack();
            respond(['error' => "Could not force-remove \"{$target['name']}\": " . $e->getMessage()], 500);
        }
        respond(['ok' => true]);
    }

    try {
        $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$targetUserId]);
    } catch (PDOException $e) {
        // Foreign key violation — this employee has task, attendance, or report history.
        respond(['error' => "Can't remove \"{$target['name']}\" — they have task, attendance, or report history tied to their account. Reassign or clear that first if you really need to delete them.", 'blockedByHistory' => true], 400);
    }

    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
