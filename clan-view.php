<?php
declare(strict_types=1);

/**
 * clan-view.php — vue SSR légère de clan.html (audit P1-7).
 *
 * Sert la page clan.html avec des métadonnées serveur (titre, description,
 * Open Graph, JSON-LD, canonical) calculées depuis MySQL quand l'identifiant
 * est valide. Le contenu HTML/JS d'origine est conservé tel quel : le JS
 * enrichit ensuite la page normalement.
 *
 * Dégradation gracieuse TOTALE : secrets absents, PDO indisponible,
 * identifiant invalide, ligne introuvable → métadonnées statiques
 * d'origine, page strictement identique à clan.html.
 *
 * NB : bootstrap volontairement indépendant de api/config.php (qui exit(500)
 * si les secrets manquent — inacceptable pour une page publique) : on
 * réplique sa résolution de chemins + PDO avec timeout court et fallback.
 */

$SSR = null; /* null = dégradation statique */

$__paths = [];
$__home  = getenv('HOME');
if (is_string($__home) && $__home !== '') {
    $__paths[] = rtrim($__home, '/') . '/.tfs_secrets/tfh-secrets.json';
}
/* prod : webroot = <home>/public_html/<domaine> (2 niveaux au-dessus) */
$__paths[] = dirname(__DIR__, 2) . '/.tfs_secrets/tfh-secrets.json';
/* dev  : webroot = <home>/dev.thefronthub.com (1 niveau au-dessus) */
$__paths[] = dirname(__DIR__, 1) . '/.tfs_secrets/tfh-secrets.json';

$__my = null;
foreach ($__paths as $__p) {
    if (is_readable($__p)) {
        $__sec = json_decode((string) file_get_contents($__p), true);
        if (is_array($__sec) && is_array($__sec['mysql'] ?? null)) { $__my = $__sec['mysql']; break; }
    }
}

if ($__my !== null) {
    try {
        $pdo = new PDO(
            sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                (string) ($__my['host'] ?? 'localhost'),
                (int) ($__my['port'] ?? 3306),
                (string) ($__my['database'] ?? '')),
            (string) ($__my['username'] ?? ''),
            (string) ($__my['password'] ?? ''),
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
             PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
             PDO::ATTR_TIMEOUT => 2]
        );
        /* ── P1-7 : métadonnées du clan (?tag=) ── */
        $tag = isset($_GET['tag']) && is_string($_GET['tag']) ? trim((string) $_GET['tag']) : '';
        if ($tag !== '' && mb_strlen($tag) <= 16 && preg_match('/^[A-Za-z0-9_\\-]{1,16}$/u', $tag)) {
            $tag = strtoupper($tag);
            $sm = $pdo->prepare(
                "SELECT r.clan_tag, COUNT(DISTINCT r.public_id) AS members,
                        COUNT(*) AS games, SUM(r.won) AS wins
                 FROM tfh_g_roster r
                 WHERE r.clan_tag = ?");
            $sm->execute([$tag]);
            $cl = $sm->fetch();
            if (is_array($cl) && (int) ($cl['games'] ?? 0) > 0) {
                $members = (int) $cl['members'];
                $games   = (int) $cl['games'];
                $wins    = (int) $cl['wins'];
                $rate    = $games > 0 ? round($wins * 100 / $games, 1) : 0;
                $SSR = [
                    'canonical' => 'https://thefronthub.com/clan.html?tag=' . rawurlencode($tag),
                    'title'     => 'Clan ' . $tag . ' — ' . $members . ' membres, '
                                 . $wins . ' victoires · TheFrontHub',
                    'desc'      => 'Fiche du clan OpenFront ' . $tag . ' : ' . $members
                                 . ' membres, ' . $games . ' parties suivies, ' . $wins
                                 . ' victoires (' . $rate . ' %). Activité 30 jours, sessions officielles et joueurs sur TheFrontHub.',
                    'type'      => 'profile',
                    'summary'   => 'Clan ' . $tag . ' · ' . $members . ' membres · '
                                 . $games . ' parties · ' . $wins . ' victoires (' . $rate . ' %)',
                ];
            }
        }
    } catch (Throwable $e) {
        /* SSR indisponible : page statique de secours, aucun log bruyant */
        $SSR = null;
    }
}

if (is_array($SSR)) {
    /* En-têtes : pas de cache navigateur (métadonnées par identifiant) */
    header('Cache-Control: no-cache, must-revalidate');
} else {
    header('Cache-Control: public, max-age=300, must-revalidate');
}
header('X-Content-Type-Options: nosniff');

function ssr_e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

/* JSON-LD Schema.org (Organization = clan) */
if (is_array($SSR)) {
    $SSR['jsonld'] = json_encode([
        '@context'    => 'https://schema.org',
        '@type'       => 'Organization',
        'name'        => 'Clan ' . strtoupper((string) ($_GET['tag'] ?? '')),
        'url'         => $SSR['canonical'],
        'description' => $SSR['desc'],
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
?><!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<?php if (is_array($SSR)): ?>
  <title><?= ssr_e($SSR['title']) ?></title>
  <meta name="description" content="<?= ssr_e($SSR['desc']) ?>">
  <meta property="og:title" content="<?= ssr_e($SSR['title']) ?>">
  <meta property="og:description" content="<?= ssr_e($SSR['desc']) ?>">
  <meta property="og:type" content="<?= ssr_e($SSR['type']) ?>">
  <meta property="og:url" content="<?= ssr_e($SSR['canonical']) ?>">
  <meta property="og:image" content="https://thefronthub.com/TheFrontHub%20Logo%20No%20Text.webp">
  <meta property="og:site_name" content="TheFrontHub">
  <meta property="og:locale" content="fr_FR">
  <meta name="twitter:card" content="summary">
  <script type="application/ld+json"><?= $SSR['jsonld'] ?></script>
<?php else: ?>
  <title>TheFrontHub — Clan</title>
  <meta name="description" content="Fiche d'un clan OpenFront : membres, parties récentes, sessions officielles et activité 30 jours.">
<?php endif ?>
<?php if (is_array($SSR)): ?>
<link rel="canonical" href="<?= ssr_e($SSR['canonical']) ?>">
<?php else: ?>
<link rel="canonical" href="https://thefronthub.com/clan.html">
<?php endif ?>
<link rel="alternate" hreflang="fr" href="https://thefronthub.com/clan.html">
<link rel="alternate" hreflang="x-default" href="https://thefronthub.com/clan.html">
  <link rel="icon" type="image/png" href="favicon-32x32.png">
  <link rel="stylesheet" href="styles.css?v=94">
  <style>
    :root { --gp-radius: 14px; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; margin: 0; }
    .gp-wrap { max-width: 1080px; margin: 0 auto; padding: 20px 16px 48px; }
    .gp-top { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; flex-wrap: wrap; }
    .gp-top img { height: 34px; }
    .gp-back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); text-decoration: none; font-size: 14px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 999px; transition: all .15s; }
    .gp-back:hover { color: var(--orange); border-color: var(--orange); }
    .gp-card { background: var(--panel, var(--bg)); border: 1px solid var(--border); border-radius: var(--gp-radius); padding: 20px; margin-bottom: 16px; }
    .gp-card h2 { margin: 0 0 10px; font-size: 16px; }
    .gp-clanhead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
    .gp-clanhead h1 { font-size: 28px; margin: 0; font-weight: 800; }
    .gp-clantag { font-size: 14px; font-weight: 800; padding: 6px 14px; border-radius: 10px; background: color-mix(in srgb, var(--orange) 14%, transparent); color: var(--orange); border: 1px solid color-mix(in srgb, var(--orange) 35%, transparent); letter-spacing: 1px; }
    .gp-sub { color: var(--muted); font-size: 13.5px; margin: 2px 0 14px; }
    .gp-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
    .gp-stat { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
    .gp-stat b { display: block; font-size: 18px; }
    .gp-stat span { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
    .gp-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .gp-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); padding: 8px 10px; border-bottom: 2px solid var(--border); }
    .gp-table td { padding: 9px 10px; border-bottom: 1px solid var(--border); }
    .gp-table tr:last-child td { border-bottom: none; }
    .gp-player { color: inherit; text-decoration: none; font-weight: 600; }
    .gp-player:hover { color: var(--orange); }
    .gp-gamerow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; text-decoration: none; color: inherit; transition: border-color .15s, transform .15s; flex-wrap: wrap; }
    .gp-gamerow:hover { border-color: var(--orange); transform: translateY(-1px); }
    .gp-gamerow b { font-weight: 700; }
    .gp-muted { color: var(--muted); font-size: 13px; }
    .gp-pill { font-size: 11px; font-weight: 800; padding: 3px 10px; border-radius: 999px; }
    .gp-pill.win { background: rgba(16,185,129,.12); color: #10b981; }
    .gp-pill.loss { background: rgba(239,68,68,.10); color: #ef4444; }
    .gp-chart { width: 100%; height: 120px; }
    .gp-chart .bar { fill: var(--orange); opacity: .85; }
    .gp-chart .bar.win { fill: #10b981; }
    .gp-empty { color: var(--muted); text-align: center; padding: 26px 0; }
    .gp-loading { display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--muted); padding: 60px 0; }
    .gp-spinner { width: 26px; height: 26px; border: 3px solid var(--border); border-top-color: var(--orange); border-radius: 50%; animation: gp-spin .8s linear infinite; }
    @keyframes gp-spin { to { transform: rotate(360deg); } }
    .gp-err { text-align: center; color: #ef4444; padding: 40px 0; }
    @media (max-width: 640px) { .gp-clanhead h1 { font-size: 22px; } }
  </style>
</head>
<body>
  <div class="gp-wrap">
    <?php if (is_array($SSR)): ?>
    <noscript><div class="gp-card" style="margin-bottom:14px"><b><?= ssr_e($SSR['summary']) ?></b> — <a href="/?ref=noscript">voir les classements TheFrontHub</a>.</div></noscript>
    <?php endif ?>

    <div class="gp-top">
      <img src="TheFrontHub%20Logo%20Text.webp" alt="TheFrontHub">
      <a class="gp-back" href="dashboard.html">← Tableau de bord</a>
    </div>
    <div id="gp-root">
      <div class="gp-loading"><div class="gp-spinner"></div> Chargement du clan…</div>
    </div>
  </div>

<script>
(function () {
  'use strict';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmtDate = function (s) {
    if (!s) return '—';
    try { return new Date(String(s).replace(' ', 'T') + (/[Zz+]/.test(String(s)) ? '' : 'Z')).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(s); }
  };
  var pct = function (w, t) { return (t > 0) ? Math.round((w / t) * 1000) / 10 + ' %' : '—'; };
  /* v5.13 — badge « joueur vérifié » (bulle CSS de styles.css, liée ci-dessus) */
  var vBadge = function (m) {
    if (!m || !m.verified || !m.publicId) return '';
    var tip = 'Joueur vérifié — cette personne est vérifiée (identité prouvée en jeu)';
    return '<span class="tfh-vbadge" data-tip="' + esc(tip) + '" title="' + esc(tip) + '" tabindex="0" role="img" aria-label="' + esc(tip) + '">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tfh-vbadge-ic" aria-hidden="true"><path d="M12 2.2l2.3 1.9 3-.3.9 2.9 2.6 1.5-1 2.9 1 2.9-2.6 1.5-.9 2.9-3-.3-2.3 1.9-2.3-1.9-3 .3-.9-2.9L3.2 14l1-2.9-1-2.9 2.6-1.5.9-2.9 3 .3z"/><path d="M8.6 12l2.4 2.4 4.4-4.9"/></svg></span>';
  };

  function fetchJSON(url) {
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.json(); });
  }

  function dailyChart(daily) {
    if (!daily || !daily.length) return '';
    var max = 1, n = daily.length, bw = 100 / n;
    daily.forEach(function (d) { if (d.games > max) max = d.games; });
    var bars = daily.map(function (d, i) {
      var h = Math.max(4, (d.games / max) * 100);
      var wcls = d.wins > 0 ? 'bar win' : 'bar';
      return '<rect class="' + wcls + '" x="' + (i * bw + bw * 0.15).toFixed(2) + '" y="' + (100 - h).toFixed(2) + '" width="' + (bw * 0.7).toFixed(2) + '" height="' + h.toFixed(2) + '"><title>' + esc(d.day + ' : ' + d.games + ' parties, ' + d.wins + ' victoires') + '</title></rect>';
    }).join('');
    return '<svg class="gp-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Activité 30 jours">' + bars + '</svg>' +
      '<div class="gp-muted" style="display:flex;justify-content:space-between;margin-top:4px"><span>' + esc(daily[0].day) + '</span><span>' + esc(daily[n - 1].day) + '</span></div>';
  }

  function render(clan, cs) {
    var root = document.getElementById('gp-root');
    /* totaux : route=clan expose participations/wins à plat (fallback total.* par sûreté) */
    var total = {
      games: (clan.participations != null) ? clan.participations : ((clan.total && clan.total.games != null) ? clan.total.games : null),
      wins: (clan.wins != null) ? clan.wins : ((clan.total && clan.total.wins != null) ? clan.total.wins : null)
    };
    var off = clan.official || null;
    var members = clan.members || [];
    var games = clan.recentGames || [];

    var offHtml = '';
    if (off) {
      offHtml = '<div class="gp-card"><h2>🏅 Bloc officiel (90 jours)</h2><div class="gp-stats">' +
        '<div class="gp-stat"><b>' + esc(String(off.weightedWins ?? '—')) + '</b><span>Weighted wins</span></div>' +
        '<div class="gp-stat"><b>' + esc(String(off.weightedWLRatio ?? '—')) + '</b><span>W/L ratio</span></div>' +
        '<div class="gp-stat"><b>' + esc(String(off.games ?? '—')) + '</b><span>Parties</span></div>' +
        '<div class="gp-stat"><b>' + esc(String(off.playerSessions ?? '—')) + '</b><span>Sessions joueurs</span></div>' +
      '</div></div>';
    }

    var membersHtml = members.map(function (m) {
      return '<tr><td><a class="gp-player" href="profile.html?player=' + encodeURIComponent(m.username || '') + '&publicId=' + encodeURIComponent(m.publicId || '') + '">' + esc(m.username) + '</a>' + vBadge(m) + '</td>' +
        '<td>' + esc(String(m.games ?? '—')) + '</td><td>' + esc(String(m.wins ?? '—')) + '</td><td>' + esc(pct(m.wins || 0, m.games || 0)) + '</td></tr>';
    }).join('');

    var gamesHtml = games.map(function (g) {
      return '<a class="gp-gamerow" href="game.html?id=' + encodeURIComponent(g.id || '') + '">' +
        '<b>' + esc(g.map || 'Carte inconnue') + '</b>' +
        '<span class="gp-muted">' + esc(g.mode || '—') + (g.rankedType ? ' · ' + esc(g.rankedType) : '') + ' · ' + esc(String(g.numPlayers ?? '?')) + ' joueurs</span>' +
        '<span class="gp-muted">' + esc(g.startedAt || '') + '</span>' +
        (g.winner && g.winner.username ? '<span class="gp-muted">🏆 ' + esc(g.winner.username) + '</span>' : '') +
        '</a>';
    }).join('');

    var sessHtml = '';
    if (cs) {
      var rows = (cs.sessions || []).slice(0, 30).map(function (s) {
        return '<a class="gp-gamerow" href="game.html?id=' + encodeURIComponent(s.gameId || '') + '">' +
          '<span class="gp-pill ' + (s.hasWon ? 'win' : 'loss') + '">' + (s.hasWon ? 'Victoire' : 'Défaite') + '</span>' +
          '<b>' + esc(String(s.clanPlayerCount ?? '?')) + ' membres du clan</b>' +
          '<span class="gp-muted">sur ' + esc(String(s.totalPlayerCount ?? '?')) + ' joueurs</span>' +
          '<span class="gp-muted">score ' + esc(String(s.score ?? '—')) + '</span>' +
          '<span class="gp-muted">' + esc(fmtDate(s.gameStart)) + '</span>' +
          '</a>';
      }).join('');
      sessHtml = '<div class="gp-card"><h2>📡 Sessions officielles (30 jours)</h2>' +
        ((cs.daily && cs.daily.length) ? dailyChart(cs.daily) : '') +
        (rows ? '<div style="margin-top:14px;max-height:420px;overflow-y:auto">' + rows + '</div>' : '<div class="gp-empty">Aucune session récente enregistrée.</div>') +
        '</div>';
    }

    root.innerHTML =
      '<div class="gp-card">' +
        '<div class="gp-clanhead"><span class="gp-clantag">[' + esc(clan.tag || '?') + ']</span><h1>' + esc(clan.tag || 'Clan') + '</h1></div>' +
        '<p class="gp-sub">Fiche clan TheFrontHub — membres observés en base, parties récentes et sessions officielles.</p>' +
        '<div class="gp-stats">' +
          '<div class="gp-stat"><b>' + esc(String(total.games ?? '—')) + '</b><span>Parties (DB)</span></div>' +
          '<div class="gp-stat"><b>' + esc(String(total.wins ?? '—')) + '</b><span>Victoires</span></div>' +
          '<div class="gp-stat"><b>' + esc(pct(total.wins || 0, total.games || 0)) + '</b><span>Winrate</span></div>' +
          '<div class="gp-stat"><b>' + esc(String(members.length)) + '</b><span>Membres connus</span></div>' +
        '</div>' +
      '</div>' +
      offHtml +
      '<div class="gp-card"><h2>👥 Membres (' + esc(String(members.length)) + ')</h2>' +
        (members.length ? '<div style="overflow-x:auto"><table class="gp-table"><thead><tr><th>Joueur</th><th>Parties</th><th>Victoires</th><th>Winrate</th></tr></thead><tbody>' + membersHtml + '</tbody></table></div>' : '<div class="gp-empty">Aucun membre en base pour ce tag.</div>') +
      '</div>' +
      sessHtml +
      '<div class="gp-card"><h2>🎮 Parties récentes</h2>' +
        (games.length ? gamesHtml : '<div class="gp-empty">Aucune partie récente en base pour ce clan.</div>') +
      '</div>';
  }

  function fail(msg) {
    document.getElementById('gp-root').innerHTML = '<div class="gp-card"><div class="gp-err">⚠️ ' + esc(msg) + '</div></div>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var tag = (new URLSearchParams(location.search).get('tag') || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{1,10}$/.test(tag)) { fail('Tag de clan invalide ou manquant (?tag=…).'); return; }
    document.title = 'TheFrontHub — Clan [' + tag + ']';
    Promise.all([
      fetchJSON('/api/games-api.php?route=clan&tag=' + encodeURIComponent(tag) + '&limit=100'),
      fetchJSON('/api/games-api.php?route=clansessions&tag=' + encodeURIComponent(tag) + '&limit=100').catch(function () { return null; })
    ]).then(function (res) {
      var clan = res[0];
      if (!clan || !clan.ok) { fail((clan && clan.error) ? clan.error : 'Clan introuvable.'); return; }
      clan.tag = clan.tag || tag;
      render(clan, res[1]);
    }).catch(function () { fail('Erreur réseau en chargeant le clan.'); });
  });
})();
</script>
</body>
</html>
