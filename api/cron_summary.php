<?php
require_once __DIR__ . '/_bootstrap.php';

/**
 * cron_summary.php — sends the team summary email with NO admin login
 * required, so Hostinger's Cron Jobs scheduler (or any external scheduler)
 * can hit this URL unattended, e.g. once a day.
 *
 * Protected by a secret token instead of a session, since a cron job has no
 * user to log in as. Anyone who doesn't know CRON_SECRET gets a 403.
 *
 * SET UP IN HOSTINGER (hPanel → Advanced → Cron Jobs):
 *   Command:  wget -q -O /dev/null "https://canaresonline.com/logbook/api/cron_summary.php?token=CHANGE_THIS_TOKEN"
 *   Schedule: whatever you want — e.g. "Every day" at a fixed time.
 *
 * IMPORTANT: change CRON_SECRET below to your own random string before
 * setting up the cron job, and use that same string in the URL. Don't reuse
 * the placeholder — anyone who finds this file's source could otherwise
 * trigger the email themselves.
 */
define('CRON_SECRET', 'ac57a3d04cb6be6f6db85d8c4ad29619b7b2ca1241852c06');

$token = $_GET['token'] ?? '';
if (!hash_equals(CRON_SECRET, $token)) {
    http_response_code(403);
    echo json_encode(['error' => 'Invalid or missing token']);
    exit;
}

try {
    $pdo = get_db();
    $result = send_team_summary_email($pdo, 'automatic daily summary');
    if (isset($result['error'])) respond($result, 500);
    respond($result);
} catch (Exception $e) {
    respond(['error' => $e->getMessage()], 500);
}
