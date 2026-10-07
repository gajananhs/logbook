<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $name = trim($b['name'] ?? '');
    $color = trim($b['color'] ?? '');
    if ($name === '' || !preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) respond(['error' => 'Name and a valid hex color required'], 400);

    $maxRow = $pdo->query('SELECT COALESCE(MAX(sort_order),0) AS m FROM statuses')->fetch();
    $sortOrder = (int)$maxRow['m'] + 1;
    $id = uid('st');
    $isDone = !empty($b['isDone']) ? 1 : 0;
    $stmt = $pdo->prepare('INSERT INTO statuses (id, name, color, is_done, sort_order) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$id, $name, $color, $isDone, $sortOrder]);
    respond(['status' => ['id' => $id, 'name' => $name, 'color' => $color, 'isDone' => (bool)$isDone, 'sortOrder' => $sortOrder]]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
