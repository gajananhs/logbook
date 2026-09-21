<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    // Optional date-range filter on WHEN the report was saved (not the
    // report's own data range) — lets the history list be narrowed down.
    $filterStart = $_GET['rangeStart'] ?? null;
    $filterEnd = $_GET['rangeEnd'] ?? null;

    $sql = 'SELECT r.id, r.type, r.range_start, r.range_end, r.created_at, u.name AS generated_by_name
            FROM reports r JOIN users u ON u.id = r.generated_by WHERE 1=1';
    $params = [];
    if ($filterStart) { $sql .= ' AND r.created_at >= ?'; $params[] = $filterStart . ' 00:00:00'; }
    if ($filterEnd) { $sql .= ' AND r.created_at <= ?'; $params[] = $filterEnd . ' 23:59:59'; }
    $sql .= ' ORDER BY r.created_at DESC LIMIT 200';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['rangeStart'] = $r['range_start']; unset($r['range_start']);
        $r['rangeEnd'] = $r['range_end']; unset($r['range_end']);
        $r['createdAt'] = $r['created_at']; unset($r['created_at']);
        $r['generatedByName'] = $r['generated_by_name']; unset($r['generated_by_name']);
    }
    unset($r);
    respond(['reports' => $rows]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}