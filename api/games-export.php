<?php
declare(strict_types=1);

/**
 * api/games-export.php — Génère les payloads speedruns publics DEPUIS MySQL.
 *
 * « Nouveau départ » (2026-09-23) : remplace l'ancien pipeline GitHub
 * (sync-standard → release data-latest → pull-data.sh). Les fichiers
 * runs_public.json(.gz) et runs_compact_public.json(.gz) du webroot sont
 * régénérés LOCALEMENT depuis les tables tfh_g_* (remplies par
 * api/games-sync.php) — avec le VRAI publicId du gagnant dans `playerId`.
 *
 * Format identique à l'ancien payload compact (décodé par
 * decodeCompactPayload d'app.js / decodeSpeedrunPayload de profile.js) :
 *   { t: total, u: date ISO, c: null, m: {carte: total}, k: [clés], r: [[…]] }
 *   k = id, player, playerId, map, duration_s, difficulty, bots, players, timestamp
 *   r = top 30 par carte (meilleur temps d'abord)
 *
 * CLI uniquement — appelé par deploy.sh après pull-data (toutes les 5 min) :
 *   /usr/local/bin/php /home/USER/public_html/thefronthub.com/api/games-export.php
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden (CLI only)');
}

error_reporting(E_ALL & ~E_DEPRECATED);

/* ─────────────────────────── Secrets / PDO ─────────────────────────── */

$secrets = null;
foreach ([
    rtrim((string) getenv('HOME'), '/') . '/.tfs_secrets/tfh-secrets.json',
    dirname(__DIR__, 3) . '/.tfs_secrets/tfh-secrets.json',
] as $p) {
    if (is_readable($p)) {
        $d = json_decode((string) file_get_contents($p), true);
        if (is_array($d)) { $secrets = $d; break; }
    }
}
if (!is_array($secrets) || !is_array($secrets['mysql'] ?? null)) {
    fwrite(STDERR, "[games-export] secrets introuvables (~/.tfs_secrets/tfh-secrets.json)\n");
    exit(1);
}

$m = $secrets['mysql'];
try {
    $pdo = new PDO(
        sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', (string)$m['host'], (int)($m['port'] ?? 3306), (string)$m['database']),
        (string)$m['username'],
        (string)$m['password'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]
    );
} catch (Throwable $e) {
    fwrite(STDERR, '[games-export] PDO: ' . $e->getMessage() . "\n");
    exit(1);
}

/* ─────────────────────────── Anti-chevauchement ─────────────────────────── */

$lockFp = fopen(sys_get_temp_dir() . '/tfh-games-export.lock', 'c');
if (!$lockFp || !flock($lockFp, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "[games-export] une instance tourne déjà — sortie\n");
    exit(0);
}

/* ─────────────────────────── Export ─────────────────────────── */

$WEBROOT     = dirname(__DIR__);
$KEYS        = ['id', 'player', 'playerId', 'map', 'duration_s', 'difficulty', 'bots', 'players', 'timestamp'];
$TOP_PER_MAP = 30;

/**
 * Exporte une catégorie de speedruns vers <base>.json et <base>.json.gz.
 * Retourne [total catégorie, runs exportés].
 */
function export_category(PDO $pdo, string $category, string $base, int $topPerMap, array $keys): array {
    $st = $pdo->prepare("SELECT g.game_id, g.game_map, g.speedrun_duration_s, g.difficulty, g.bots,
            g.num_players, g.started_at, g.winner_public_id, u.username AS winner_name
        FROM tfh_g_games g LEFT JOIN tfh_g_usernames u ON u.id = g.winner_username_id
        WHERE g.speedrun_category = ? AND g.speedrun_duration_s IS NOT NULL AND g.game_map IS NOT NULL
        ORDER BY g.game_map ASC, g.speedrun_duration_s ASC, g.started_at ASC");
    $st->execute([$category]);
    $rows = $st->fetchAll();

    $mapTotals = [];
    $perMapCount = [];
    $r = [];
    foreach ($rows as $row) {
        $map = (string) $row['game_map'];
        $mapTotals[$map] = ($mapTotals[$map] ?? 0) + 1;
        if (($perMapCount[$map] ?? 0) >= $topPerMap) continue; // top N par carte
        $perMapCount[$map] = ($perMapCount[$map] ?? 0) + 1;

        // '2026-09-23 18:28:01.185' → '2026-09-23T18:28:01.185Z'
        $tsIso = str_replace(' ', 'T', substr((string) $row['started_at'], 0, 23)) . 'Z';

        $r[] = [
            (string) $row['game_id'],
            (string) ($row['winner_name'] ?? '—'),
            (string) ($row['winner_public_id'] ?? ''),
            $map,
            (int) $row['speedrun_duration_s'],
            (string) ($row['difficulty'] ?? ''),
            (int) ($row['bots'] ?? ($category === 'compact' ? 100 : 400)),
            (int) ($row['num_players'] ?? 0),
            $tsIso,
        ];
    }

    $payload = [
        't' => count($rows),                    // total catégorie (compteur « nouveau départ »)
        'u' => gmdate('Y-m-d\TH:i:s.v\Z'),      // dernière génération
        'c' => null,                            // ancien champ latestCommit (plus pertinent)
        'm' => $mapTotals,                      // totals par carte
        'k' => $keys,
        'r' => $r,                              // top N par carte
    ];
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        fwrite(STDERR, "[games-export] $category : json_encode a échoué\n");
        return [count($rows), 0];
    }
    $gz = gzencode($json, 6);

    // Écriture atomique (.tmp → rename) : un visiteur ne lit jamais un fichier à moitié écrit
    foreach ([[$base . '.gz', $gz], [$base, $json]] as [$f, $data]) {
        $tmp = $f . '.tmp.' . getmypid();
        if (file_put_contents($tmp, $data) === false) {
            fwrite(STDERR, "[games-export] écriture impossible : $tmp\n");
            @unlink($tmp);
            continue;
        }
        rename($tmp, $f);
        @chmod($f, 0644);
    }

    fwrite(STDERR, "[games-export] $category : " . count($r) . " runs (top $topPerMap/carte), total " . count($rows) . " → $base.json(.gz)\n");
    return [count($rows), count($r)];
}

[$nTotal, $nRuns] = export_category($pdo, 'normal',  $WEBROOT . '/runs_public.json',         $TOP_PER_MAP, $KEYS);
[$cTotal, $cRuns] = export_category($pdo, 'compact', $WEBROOT . '/runs_compact_public.json', $TOP_PER_MAP, $KEYS);
fwrite(STDERR, "[games-export] terminé — normal $nRuns/$nTotal, compact $cRuns/$cTotal\n");
