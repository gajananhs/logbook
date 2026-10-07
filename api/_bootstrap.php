<?php
/**
 * _bootstrap.php — shared helpers, included by every file in /api/.
 * The leading underscore keeps it from being confused with an action endpoint;
 * it is never called directly by the frontend.
 */
require_once __DIR__ . '/../config.php';

// Email-summary support is optional — if its files aren't present (or only
// partially uploaded), the rest of the app must keep working regardless.
// A missing PHPMailer library should never be able to take down login.
$GLOBALS['__EMAIL_SUMMARY_AVAILABLE'] = false;
$__smtpConfigPath = __DIR__ . '/config_smtp.php';
$__pmException = __DIR__ . '/lib/PHPMailer/Exception.php';
$__pmMailer = __DIR__ . '/lib/PHPMailer/PHPMailer.php';
$__pmSmtp = __DIR__ . '/lib/PHPMailer/SMTP.php';
if (file_exists($__smtpConfigPath) && file_exists($__pmException) && file_exists($__pmMailer) && file_exists($__pmSmtp)) {
    require_once $__smtpConfigPath;
    require_once $__pmException;
    require_once $__pmMailer;
    require_once $__pmSmtp;
    $GLOBALS['__EMAIL_SUMMARY_AVAILABLE'] = true;
}

header('Content-Type: application/json; charset=utf-8');
// If the frontend is ever hosted on a different origin than this API, uncomment and set explicitly:
// header('Access-Control-Allow-Origin: https://your-frontend-domain.com');

function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function uid($prefix) {
    return $prefix . '_' . bin2hex(random_bytes(6));
}

function body() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function notify($pdo, $userId, $message, $taskId = null) {
    $pdo->prepare('INSERT INTO notifications (id, user_id, message, task_id, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        ->execute([uid('n'), $userId, $message, $taskId, date('Y-m-d H:i:s')]);
}

/**
 * send_team_summary_email() — builds and emails the company-wide task
 * summary (totals + per-employee roster). Shared by the admin-triggered
 * button (send_summary.php) and the unattended cron endpoint
 * (cron_summary.php) so both always produce the exact same email.
 *
 * Returns ['ok' => true, 'sentTo' => ...] or ['error' => ...] — never throws,
 * so callers can respond() the result directly either way.
 */
if (!defined('APP_BASE_URL')) {
    // Base URL of the deployed app — used to build the View/Assign/Comment
    // links in the Team Summary email. Override by defining APP_BASE_URL in
    // config.php (before _bootstrap.php loads) if the app ever moves.
    define('APP_BASE_URL', 'https://canaresonline.com/logbook');
}

function send_team_summary_email(PDO $pdo, string $generatedByName) {
    if (empty($GLOBALS['__EMAIL_SUMMARY_AVAILABLE'])) {
        return ['error' => 'Email isn\'t set up yet — config_smtp.php and the PHPMailer library files need to be uploaded to /api/ and /api/lib/PHPMailer/. See the setup instructions at the top of config_smtp.php.'];
    }
    $totals = $pdo->query(
        "SELECT COUNT(*) AS total,
                SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN completed_at IS NULL AND due_date IS NOT NULL AND due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_count,
                AVG(CASE WHEN completed_at IS NOT NULL AND estimated_hours IS NOT NULL AND actual_hours IS NOT NULL AND actual_hours > 0
                    THEN LEAST(150, (estimated_hours / actual_hours) * 100) END) AS avg_eff
         FROM tasks"
    )->fetch();

    $roster = $pdo->query(
        "SELECT u.id, u.name,
                SUM(CASE WHEN t.completed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN t.completed_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_count,
                SUM(CASE WHEN t.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed_count,
                AVG(CASE WHEN t.completed_at IS NOT NULL AND t.estimated_hours IS NOT NULL AND t.actual_hours IS NOT NULL AND t.actual_hours > 0
                    THEN LEAST(150, (t.estimated_hours / t.actual_hours) * 100) END) AS avg_eff
         FROM users u LEFT JOIN tasks t ON t.assigned_to = u.id
         GROUP BY u.id, u.name
         ORDER BY u.name ASC"
    )->fetchAll();

    // Same-look "buttons" as the dashboard's Team Board Actions column, but
    // as plain <a> links — email clients can't run the dashboard's onclick
    // JS, so each link deep-links into index.html and the app itself runs
    // the exact same viewEmployeeTasks()/assignToEmployee()/toggleCommentRow()
    // functions the dashboard buttons call, once the admin is logged in.
    $actionBtnStyle = 'display:inline-block;margin:2px;padding:4px 8px;background:#1c2024;color:#ffffff;text-decoration:none;border-radius:4px;font-size:11px;white-space:nowrap;';
    $rows = '';
    foreach ($roster as $r) {
        // No qualifying completed tasks yet -> treat as 0%, not blank/dash.
        $eff = round((float)($r['avg_eff'] ?? 0)) . '%';
        $empId = urlencode($r['id']);
        $viewUrl = htmlspecialchars(APP_BASE_URL . '/index.html?empAction=view&emp=' . $empId);
        $assignUrl = htmlspecialchars(APP_BASE_URL . '/index.html?empAction=assign&emp=' . $empId);
        $commentUrl = htmlspecialchars(APP_BASE_URL . '/index.html?empAction=comment&emp=' . $empId);
        $rows .= '<tr>'
            . '<td style="padding:6px 10px;border-bottom:1px solid #333;">' . htmlspecialchars($r['name']) . '</td>'
            . '<td style="padding:6px 10px;border-bottom:1px solid #333;text-align:center;">' . (int)$r['open_count'] . '</td>'
            . '<td style="padding:6px 10px;border-bottom:1px solid #333;text-align:center;color:' . ((int)$r['overdue_count'] > 0 ? '#D2604C' : '#8B94A0') . ';">' . (int)$r['overdue_count'] . '</td>'
            . '<td style="padding:6px 10px;border-bottom:1px solid #333;text-align:center;">' . (int)$r['completed_count'] . '</td>'
            . '<td style="padding:6px 10px;border-bottom:1px solid #333;text-align:center;">' . $eff . '</td>'
            . '<td style="padding:6px 10px;border-bottom:1px solid #333;text-align:center;">'
                . '<a href="' . $viewUrl . '" style="' . $actionBtnStyle . '">View</a>'
                . '<a href="' . $assignUrl . '" style="' . $actionBtnStyle . '">Assign</a>'
                . '<a href="' . $commentUrl . '" style="' . $actionBtnStyle . '">Comment</a>'
            . '</td>'
            . '</tr>';
    }

    // Same rule for the overall stat box: 0 stays 0%, never a dash.
    $avgEffOverall = round((float)($totals['avg_eff'] ?? 0)) . '%';
    $now = date('d M Y, H:i');

    $html = <<<HTML
<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
  <h2 style="margin-bottom:4px;">LOGBOOK — Team Summary</h2>
  <p style="color:#666;margin-top:0;">Generated {$now} — {$generatedByName}</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">
    <tr>
      <td style="padding:10px;background:#f4f4f4;text-align:center;"><b style="font-size:20px;">{$totals['total']}</b><br><span style="font-size:12px;color:#666;">Total tasks</span></td>
      <td style="padding:10px;background:#f4f4f4;text-align:center;"><b style="font-size:20px;">{$totals['open_count']}</b><br><span style="font-size:12px;color:#666;">Open</span></td>
      <td style="padding:10px;background:#f4f4f4;text-align:center;"><b style="font-size:20px;color:#D2604C;">{$totals['overdue_count']}</b><br><span style="font-size:12px;color:#666;">Overdue</span></td>
      <td style="padding:10px;background:#f4f4f4;text-align:center;"><b style="font-size:20px;">{$avgEffOverall}</b><br><span style="font-size:12px;color:#666;">Avg efficiency</span></td>
    </tr>
  </table>
  <table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:#1c2024;color:#fff;">
        <th style="padding:8px 10px;text-align:left;">Name</th>
        <th style="padding:8px 10px;">Open</th>
        <th style="padding:8px 10px;">Overdue</th>
        <th style="padding:8px 10px;">Completed</th>
        <th style="padding:8px 10px;">Efficiency</th>
        <th style="padding:8px 10px;">Actions</th>
      </tr>
    </thead>
    <tbody>{$rows}</tbody>
  </table>
</div>
HTML;

    $recipients = ['ecommerce@canares.com', 'gajanan@canares.com'];
    $subject = 'LOGBOOK Team Summary — ' . date('d M Y');

    // Authenticated SMTP through a real mailbox — Google Workspace silently
    // rejects unauthenticated mail() from shared hosting outright (it doesn't
    // even land in spam), so this is not optional for Workspace recipients.
    $mail = new PHPMailer\PHPMailer\PHPMailer(true);
    $debugLog = '';
    try {
        // PHPMailer defaults to ISO-8859-1; without this, the em dash and
        // any non-ASCII characters (names, ₹ etc.) show up as garbled
        // "â€"" style mojibake in the sent email even though the HTML
        // string here is correct UTF-8.
        $mail->CharSet = PHPMailer\PHPMailer\PHPMailer::CHARSET_UTF8;
        $mail->isSMTP();
        $mail->Host = SMTP_HOST;
        $mail->Port = SMTP_PORT;
        $mail->SMTPAuth = true;
        $mail->Username = SMTP_USER;
        $mail->Password = SMTP_PASS;
        $mail->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Timeout = 15; // fail fast and clearly instead of hanging the request on a network hiccup

        // Capture the raw SMTP conversation so an auth failure shows Gmail's
        // actual reason (e.g. "Application-specific password required") instead
        // of just PHPMailer's generic wrapper message.
        $mail->SMTPDebug = PHPMailer\PHPMailer\SMTP::DEBUG_SERVER;
        $mail->Debugoutput = function ($str) use (&$debugLog) { $debugLog .= $str . "\n"; };

        $mail->setFrom(SMTP_USER, SMTP_FROM_NAME);
        foreach ($recipients as $addr) {
            $mail->addAddress($addr);
        }
        $mail->isHTML(true);
        $mail->Subject = $subject;
        $mail->Body = $html;

        $mail->send();
        return ['ok' => true, 'sentTo' => implode(', ', $recipients)];
    } catch (PHPMailer\PHPMailer\Exception $e) {
        // Pull out just the SMTP server's own response lines (the ones with a
        // numeric code) rather than dumping the entire raw conversation.
        $serverLines = [];
        foreach (explode("\n", $debugLog) as $line) {
            if (preg_match('/^\d{3}[\s-]/', trim($line))) $serverLines[] = trim($line);
        }
        $detail = $serverLines ? implode(' | ', array_slice($serverLines, -4)) : $mail->ErrorInfo;
        return ['error' => 'SMTP send failed: ' . $mail->ErrorInfo . ($detail ? ' — Gmail said: ' . $detail : '')];
    }
}

/**
 * can_assign() — the single source of truth for "who can assign a task to whom".
 * Mirrors assignableUsersFor() in assets/app.js, which only controls what the
 * picker shows; this is what actually gets enforced, since the client can't
 * be trusted.
 *   - Anyone can always assign to themselves.
 *   - Admins can assign to anyone.
 *   - A department head can assign to anyone in their department (sub-heads
 *     or employees directly — either is fine).
 *   - A sub-department head can assign to employees in their own sub-department.
 *   - A plain employee can only self-assign.
 */
function can_assign(PDO $pdo, $assignerId, $assigneeId) {
    if ($assignerId === $assigneeId) return true;

    $stmt = $pdo->prepare('SELECT is_admin, role, department_id, sub_department_id FROM users WHERE id = ?');
    $stmt->execute([$assignerId]);
    $assigner = $stmt->fetch();
    if (!$assigner) return false;
    if ($assigner['is_admin']) return true;

    $stmt->execute([$assigneeId]);
    $assignee = $stmt->fetch();
    if (!$assignee) return false;

    if ($assigner['role'] === 'dept_head') {
        return $assigner['department_id'] !== null && $assignee['department_id'] === $assigner['department_id'];
    }
    if ($assigner['role'] === 'sub_head') {
        return $assigner['sub_department_id'] !== null && $assignee['sub_department_id'] === $assigner['sub_department_id'];
    }
    return false;
}

// Every api/*.php file wraps its logic in this try/catch pattern:
//   require_once __DIR__ . '/_bootstrap.php';
//   try {
//       $pdo = get_db();
//       ... prepared statements only ...
//   } catch (Exception $e) {
//       respond(['error' => $e->getMessage()], 500);
//   }

/**
 * ---- REPEATED WORK ------------------------------------------------------
 * Self-healing schema guard (same pattern Sales Report uses): if these
 * columns were never added to `tasks`, this adds them on first use instead
 * of every repeat-related call failing with a raw SQL error. Cheap
 * (one information_schema lookup, cached per-request) and safe to call
 * from every endpoint that touches repeat_type/repeat_parent_id.
 */
function ensure_repeat_columns(PDO $pdo): void
{
    static $done = false;
    if ($done) return;
    try {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM information_schema.columns
             WHERE table_schema = ? AND table_name = "tasks" AND column_name = "repeat_type"'
        );
        $stmt->execute([DB_NAME]);
        if (!$stmt->fetch()) {
            $pdo->exec("ALTER TABLE tasks ADD COLUMN repeat_type VARCHAR(10) NOT NULL DEFAULT 'none' AFTER estimated_hours");
        }
        $stmt = $pdo->prepare(
            'SELECT 1 FROM information_schema.columns
             WHERE table_schema = ? AND table_name = "tasks" AND column_name = "repeat_parent_id"'
        );
        $stmt->execute([DB_NAME]);
        if (!$stmt->fetch()) {
            $pdo->exec("ALTER TABLE tasks ADD COLUMN repeat_parent_id VARCHAR(40) NULL AFTER repeat_type");
        }
        $done = true;
    } catch (Throwable $e) {
        // Best-effort — worst case a repeat-specific call below throws its
        // own clear SQL error instead of silently mismatching the schema.
    }
}

/**
 * Adds exactly one Daily/Weekly/Monthly interval to a Y-m-d date string.
 * Monthly clamps to the last valid day of the target month instead of
 * overflowing (e.g. 31 Jan + 1 month -> 28/29 Feb, never 3 Mar) — the
 * common gotcha with PHP's raw '+1 month' modify().
 */
function add_repeat_interval(string $dateStr, string $repeatType): string
{
    $date = new DateTime($dateStr);
    switch ($repeatType) {
        case 'daily':
            $date->modify('+1 day');
            break;
        case 'weekly':
            $date->modify('+7 days');
            break;
        case 'monthly':
            $day = (int)$date->format('d');
            $date->modify('first day of next month');
            $daysInTargetMonth = (int)$date->format('t');
            $date->modify('+' . (min($day, $daysInTargetMonth) - 1) . ' days');
            break;
    }
    return $date->format('Y-m-d');
}

/**
 * Generates the next occurrence of a repeating task, once the current one
 * is completed or explicitly renewed. Next due date is calculated from the
 * PREVIOUS due date (not "today"), so a fixed cadence (e.g. every Monday)
 * doesn't drift just because someone completed it a day late. The new
 * occurrence starts on the same open/default status add_task.php would use,
 * keeps the same repeat_type, and links back to repeat_parent_id (the
 * original task in the series, so the whole chain can be traced).
 * Returns the new task's id, or null if this task isn't a repeating one
 * (or there's no open status configured to put the new occurrence into).
 */
function spawn_next_occurrence(PDO $pdo, string $taskId): ?string
{
    ensure_repeat_columns($pdo);

    $stmt = $pdo->prepare('SELECT * FROM tasks WHERE id = ?');
    $stmt->execute([$taskId]);
    $t = $stmt->fetch();
    if (!$t || empty($t['repeat_type']) || $t['repeat_type'] === 'none') {
        return null;
    }

    $anchor = $t['due_date'] ?: date('Y-m-d');
    $nextDue = add_repeat_interval($anchor, $t['repeat_type']);

    $statusRow = $pdo->query("SELECT id FROM statuses WHERE is_done = 0 ORDER BY sort_order ASC LIMIT 1")->fetch();
    if (!$statusRow) return null; // no open status configured to put the new occurrence into

    $newId = uid('t');
    $now = date('Y-m-d H:i:s');
    $seriesId = $t['repeat_parent_id'] ?: $t['id'];

    $stmt = $pdo->prepare(
        'INSERT INTO tasks (id, title, description, assigned_to, assigned_by, created_at, due_date, estimated_hours, status, repeat_type, repeat_parent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $newId, $t['title'], $t['description'], $t['assigned_to'], $t['assigned_by'],
        $now, $nextDue, $t['estimated_hours'], $statusRow['id'], $t['repeat_type'], $seriesId,
    ]);

    if ($t['assigned_to'] !== $t['assigned_by']) {
        notify($pdo, $t['assigned_to'], "Repeated task renewed: {$t['title']} (due {$nextDue})", $newId);
    }

    return $newId;
}