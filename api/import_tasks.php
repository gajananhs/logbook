<?php
/**
 * import_tasks.php — creates tasks from the Excel import (assets/import_excel.js).
 *
 * Only an ADMIN named Prabhakaran may call this (can_import_excel() in _bootstrap.php).
 * The browser reads the workbook and sends already-matched rows:
 *   { requestingUserId, sheet, rows: [ {employeeId, targetDate, title, description, basis}, ... ] }
 *
 * What it does / does not do:
 *   - ONLY inserts rows into `tasks`. Never touches users, PINs, salary, departments or existing tasks.
 *   - employeeId must already exist (no employee is ever created here).
 *   - Each task is scheduled for its own targetDate (due_date + available_from). It shows on the
 *     employee's dashboard, and they get the beep notification, on that date — release happens in
 *     release_scheduled_tasks() (_bootstrap.php).
 *   - Re-uploading the same sheet is safe: a row already imported (same employee + date + TO NO +
 *     part + customer) is skipped as a duplicate, never overwritten.
 */
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();
    ensure_repeat_columns($pdo);
    ensure_import_columns($pdo);

    $b = body();
    $requesterId = $b['requestingUserId'] ?? null;
    if (!can_import_excel($pdo, $requesterId)) {
        respond(['error' => 'Excel import is not available for your account'], 403);
    }

    $rows = $b['rows'] ?? null;
    if (!is_array($rows) || count($rows) === 0) respond(['error' => 'No rows to import'], 400);
    if (count($rows) > 300) respond(['error' => 'Too many rows in one request (max 300)'], 400);

    $statusRow = $pdo->query("SELECT id FROM statuses WHERE is_done = 0 ORDER BY sort_order ASC LIMIT 1")->fetch();
    if (!$statusRow) respond(['error' => 'No statuses configured'], 400);
    $statusId = $statusRow['id'];

    $userExists = $pdo->prepare('SELECT 1 FROM users WHERE id = ?');
    $dupCheck = $pdo->prepare('SELECT 1 FROM tasks WHERE import_key = ? LIMIT 1');
    $insert = $pdo->prepare(
        'INSERT INTO tasks (id, title, description, assigned_to, assigned_by, created_at, due_date, estimated_hours, status, repeat_type, available_from, release_notified, import_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)'
    );

    $created = 0;
    $duplicates = 0;
    $invalid = [];
    $now = date('Y-m-d H:i:s');
    $allowedCache = [];

    $pdo->beginTransaction();
    try {
        foreach ($rows as $i => $row) {
            $label = 'Row ' . ($i + 1);
            if (!is_array($row)) { $invalid[] = "$label: bad format"; continue; }

            $employeeId = trim((string)($row['employeeId'] ?? ''));
            $targetDate = trim((string)($row['targetDate'] ?? ''));
            $title = trim((string)($row['title'] ?? ''));
            $description = trim((string)($row['description'] ?? ''));
            $basis = trim((string)($row['basis'] ?? ''));

            if ($employeeId === '' || $title === '' || $basis === '') { $invalid[] = "$label: missing employee, title or key"; continue; }
            if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $targetDate, $m) || !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
                $invalid[] = "$label ($title): invalid target date"; continue;
            }

            if (!isset($allowedCache[$employeeId])) {
                $userExists->execute([$employeeId]);
                $allowedCache[$employeeId] = (bool)$userExists->fetch() && can_assign($pdo, $requesterId, $employeeId);
            }
            if (!$allowedCache[$employeeId]) { $invalid[] = "$label ($title): employee not found or not assignable"; continue; }

            $key = sha1('xl1|' . $employeeId . '|' . $targetDate . '|' . $basis);
            $dupCheck->execute([$key]);
            if ($dupCheck->fetch()) { $duplicates++; continue; }

            $insert->execute([
                uid('t'), mb_substr($title, 0, 250), $description !== '' ? $description : null,
                $employeeId, $requesterId, $now, $targetDate, $statusId, 'none', $targetDate, $key,
            ]);
            $created++;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }

    // Tasks whose target date is today (or already past) go live right now, with the
    // notification/beep; future-dated ones are released on their date.
    release_scheduled_tasks($pdo);

    respond(['ok' => true, 'created' => $created, 'duplicates' => $duplicates, 'invalid' => $invalid]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
