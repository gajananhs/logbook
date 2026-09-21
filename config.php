<?php
/**
 * config.php — the ONLY file you need to edit when deploying.
 *
 * Where to find these values in Hostinger hPanel:
 *   hPanel → Databases → MySQL Databases
 *   - DB_HOST   → "localhost" almost always (Hostinger runs MySQL on the same
 *                 server as your PHP). Only changes if Hostinger support tells
 *                 you to use a remote host.
 *   - DB_NAME   → shown as "Database name" in hPanel, usually looks like
 *                 u123456789_logbook (Hostinger prefixes it with your account ID)
 *   - DB_USER   → shown as "Username", usually u123456789_dbuser
 *   - DB_PASS   → the password you set when creating the database user in hPanel
 *                 (hPanel does not show it again later — reset it there if lost)
 *
 * Nothing else in this project should ever contain credentials or connection
 * details. Every file under /api/ pulls the connection from here via get_db().
 */

// Hostinger's PHP defaults to UTC regardless of where your team actually is,
// so every clock-in/task/notification timestamp was being written in UTC —
// several hours off from wall-clock time for anyone in India. This fixes
// that at the source. If your team is NOT in India, change this to your
// zone — see the list of valid names at https://www.php.net/manual/en/timezones.php
date_default_timezone_set('Asia/Kolkata');

define('DB_HOST', 'localhost');
define('DB_NAME', 'u924350731_Logbook');    // <-- replace with your hPanel database name
define('DB_USER', 'u924350731_Logbook');     // <-- replace with your hPanel database username
define('DB_PASS', 'Logbook@2026'); // <-- replace with your hPanel database password

/**
 * ---- SALES REPORTER SINGLE SIGN-ON ----------------------------------
 * Lets someone click "Logbook" inside Sales Reporter and land here
 * already logged in, matched by name — no PIN prompt.
 * MUST be the exact same string as $SSO_SHARED_SECRET in Sales
 * Reporter's config.php. Generate one with:
 *   php -r "echo bin2hex(random_bytes(32));"
 */
define('SSO_SHARED_SECRET', '0d3e208b7351527e2b2eb156f10ed5ae8b8f862ba683fc1838e7c1c2188a6636');

/**
 * ---- BACK TO SALES REPORTER -------------------------------------------
 * Lets someone click "Back to Sales Report" inside Logbook and land back
 * in Sales Reporter already logged in, matched by name — the reverse of
 * the handoff above. Uses the SAME SSO_SHARED_SECRET defined just above.
 */
define('SALES_REPORT_URL', 'https://canaresonline.com/Salesreport/index.php');

/**
 * get_db() — returns a single shared PDO connection.
 * Every api/*.php file calls this instead of connecting itself.
 */
function get_db() {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
            // Match MySQL's own NOW()/CURRENT_TIMESTAMP to the same zone as PHP,
            // so the one report query that uses NOW() (ongoing-shift duration)
            // doesn't disagree with everything else on the site.
            $pdo->exec("SET time_zone = '+05:30'");
        } catch (PDOException $e) {
            // Never leak raw connection errors (they can contain credentials).
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'Database connection failed. Check config.php credentials.']);
            exit;
        }
    }
    return $pdo;
}