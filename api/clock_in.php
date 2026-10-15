<?php
require_once __DIR__ . '/_bootstrap.php';

// Clock-in geofence — keep in sync with officeLocation in assets/js/config.js.
// Canares Automation Pvt. Ltd., Plot No. 85, Industrial Suburb, Yeshwanthpur, Bengaluru 560022.
if (!defined('OFFICE_LAT'))      define('OFFICE_LAT', 13.0220838);
if (!defined('OFFICE_LNG'))      define('OFFICE_LNG', 77.5435231);
if (!defined('OFFICE_RADIUS_M')) define('OFFICE_RADIUS_M', 10);

function distance_m($lat1, $lng1, $lat2, $lng2) {
    $R = 6371000; $r = M_PI / 180;
    $dLat = ($lat2 - $lat1) * $r; $dLng = ($lng2 - $lng1) * $r;
    $a = sin($dLat / 2) ** 2 + cos($lat1 * $r) * cos($lat2 * $r) * sin($dLng / 2) ** 2;
    return 2 * $R * atan2(sqrt($a), sqrt(1 - $a));
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

try {
    $pdo = get_db();

    $b = body();
    $userId = $b['userId'] ?? null;
    if (!$userId) respond(['error' => 'Missing userId'], 400);

    $lat = $b['lat'] ?? null; $lng = $b['lng'] ?? null;
    if ($lat === null || $lng === null || !is_numeric($lat) || !is_numeric($lng)) {
        respond(['error' => 'Location is required to clock in — allow location access and try again'], 400);
    }
    $d = distance_m((float)$lat, (float)$lng, OFFICE_LAT, OFFICE_LNG);
    if ($d > OFFICE_RADIUS_M) {
        respond(['error' => 'You are ' . round($d) . ' m from the office. Clock-in works only within ' . OFFICE_RADIUS_M . ' m of the office.'], 403);
    }

    $stmt = $pdo->prepare('SELECT id FROM attendance WHERE user_id = ? AND clock_out IS NULL LIMIT 1');
    $stmt->execute([$userId]);
    if ($stmt->fetch()) respond(['error' => 'Already clocked in'], 400);

    $id = uid('att');
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare('INSERT INTO attendance (id, user_id, clock_in, lat_in, lng_in) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$id, $userId, $now, $b['lat'] ?? null, $b['lng'] ?? null]);
    respond(['id' => $id, 'clockIn' => $now]);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
