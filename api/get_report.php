<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $reportId = $_GET['reportId'] ?? null;
    if (!$reportId) respond(['error' => 'Missing reportId'], 400);
    $stmt = $pdo->prepare('SELECT id, type, range_start, range_end, data, created_at FROM reports WHERE id = ?');
    $stmt->execute([$reportId]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Report not found'], 404);
    respond(['id' => $row['id'], 'type' => $row['type'], 'rangeStart' => $row['range_start'],
             'rangeEnd' => $row['range_end'], 'createdAt' => $row['created_at'], 'data' => json_decode($row['data'], true)]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
