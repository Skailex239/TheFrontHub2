<?php
declare(strict_types=1);

/**
 * api/csp-report.php — Endpoint de rapport Content-Security-Policy (audit P1-3).
 *
 * Receives POST application/csp-report (or application/json) sent by browsers
 * via the CSP report-uri / report-to directive. Responses: always 204 No Content
 * (the browser does not expect anything else, and we do not want to generate
 * traffic).
 *
 * Storage: jsonl file next to the API (api/csp-reports.jsonl) — inaccessible
 * via HTTP (api/.htaccess blocks *.jsonl? no: extension not in the list →
 * added). Self-rotation: the file is archived (.1) and reset every 1 Mo;
 * we keep only the last 500 lines.
 *
 * Usage (read): tail -5 /home/USER/dev.thefronthub.com/api/csp-reports.jsonl
 * Each line: {"t":"ISO date","ip":"hash","report":{...original csp-report...}}
 */

define('TFH_API', 1);
require __DIR__ . '/config.php';

header('X-Content-Type-Options: nosniff');

/* POST only — the CSP report arrives as a body */
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}

/* Soft rate limit: 60 reports / minute / IP (a broken page can send 1
 * report/resource/refresh — we protect the disk without losing signal). */
$ipHash = hash('sha256', (client_ip() ?: 'unknown') . '|tfh-csp-salt');
$cacheFile = sys_get_temp_dir() . '/tfh-csp-' . $ipHash . '.cnt';
$now = time();
$cnt = @json_decode((string)@file_get_contents($cacheFile), true);
if (!is_array($cnt) || ($cnt['t'] ?? 0) < $now - 60) {
    $cnt = ['t' => $now, 'n' => 0];
}
$cnt['n']++;
@file_put_contents($cacheFile, json_encode($cnt));
if ($cnt['n'] > 60) {
    http_response_code(204);
    exit;
}

/* Read the report (2 formats: csp-report (old) / report (report-to)) */
$raw = (string) file_get_contents('php://input');
if (strlen($raw) > 64 * 1024) {          // 64 Ko max per report
    http_response_code(413);
    exit;
}
$parsed = json_decode($raw, true);
$report = null;
if (is_array($parsed)) {
    $report = $parsed['csp-report'] ?? $parsed['report'] ?? $parsed ?: null;
}
if (!is_array($report)) {
    /* invalid body: exit quietly (a scanner is testing the endpoint) */
    http_response_code(204);
    exit;
}

/* Cleaning: we only keep the useful keys (no full DOM state) */
$keep = [];
foreach (['document-uri', 'referrer', 'violated-directive', 'effective-directive',
          'original-policy', 'disposition', 'blocked-uri', 'status-code',
          'source-file', 'line-number', 'column-number', 'script-sample'] as $k) {
    if (isset($report[$k]) && is_scalar($report[$k])) {
        $keep[$k] = mb_substr((string) $report[$k], 0, 300);
    }
}

$line = json_encode(
    ['t' => gmdate('c'), 'ip' => substr($ipHash, 0, 12), 'report' => $keep],
    JSON_UNESCAPED_SLASHES
);

/* Atomic append + rotation */
$logFile = __DIR__ . '/csp-reports.jsonl';
if (@file_put_contents($logFile, $line . "\n", FILE_APPEND | LOCK_EX) !== false) {
    clearstatcache(true, $logFile);
    if (filesize($logFile) > 1024 * 1024) {
        @rename($logFile, $logFile . '.1');           // rotation (one previous generation)
        /* trim: keep the last 500 lines */
        $all = @file($logFile, FILE_IGNORE_NEW_LINES);
        if (is_array($all) && count($all) > 500) {
            @file_put_contents($logFile, implode("\n", array_slice($all, -500)) . "\n");
        }
    }
}

http_response_code(204);
exit;
