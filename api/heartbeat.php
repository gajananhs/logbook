<?php
require_once __DIR__ . '/_bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $userId = $b['userId'] ?? null;
    if (!$userId) respond(['error' => 'Missing userId'], 400);
    $lat = isset($b['lat']) ? (float)$b['lat'] : null;
    $lng = isset($b['lng']) ? (float)$b['lng'] : null;
    $now = date('Y-m-d H:i:s');

    if ($lat !== null && $lng !== null) {
        $pdo->prepare('UPDATE users SET last_seen = ?, last_lat = ?, last_lng = ?, location_at = ? WHERE id = ?')
            ->execute([$now, $lat, $lng, $now, $userId]);
    } else {
        $pdo->prepare('UPDATE users SET last_seen = ? WHERE id = ?')->execute([$now, $userId]);
    }
    respond(['ok' => true]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
