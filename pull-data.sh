#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pull-data.sh — À INSTALLER SUR o2SWITCH (côté serveur)
#
# 🔄 Rôle : télécharger les données du site depuis la release GitHub publique
# « data-latest » du repo Skailex239/TheFrontHub2 et les installer dans le
# webroot. C'est le complément du cron de déploiement code (git fetch + rsync) :
# le cron déploie le CODE, ce script déploie les DONNÉES.
#
# ⚠️ Contexte (audit 2026-08-27) : le WAF o2switch coupe les POST des IP
# GitHub/Azure → GitHub Actions ne peut plus pousser les données vers
# _upload.php. Le flux est inversé : GitHub publie, le serveur télécharge.
#
# INSTALLATION (une seule fois) :
#   1. Copier ce fichier sur le serveur :  /home2/mask6607/pull-data.sh
#   2. chmod +x /home2/mask6607/pull-data.sh
#   3. Ajouter au cron cPanel (à la suite de la commande existante) :
#        && bash /home2/mask6607/pull-data.sh >> /home2/mask6607/logs/pull-data.log 2>&1
#
# Fonctionnalités :
#   - Téléchargements atomiques (fichier .tmp puis rename) : un visiteur ne
#     voit jamais un fichier à moitié téléchargé.
#   - Anti-chevauchement (flock) : deux exécutions simultanées impossibles.
#   - runs.json.gz (16 Mo) re-téléchargé au maximum 1×/24 h (fallback rare).
#   - Échec d'un fichier = fichier précédent conservé (jamais de regression).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# ══ Configuration ════════════════════════════════════════════════════════════
WEB_ROOT="${TFS_WEB_ROOT:-/home2/mask6607/public_html/thefronthub.com}"
REPO="Skailex239/TheFrontHub2"
TAG="data-latest"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
ARCHIVE_MAX_AGE=$((24 * 3600))   # runs.json.gz : 1 téléchargement / 24 h max

# ══ Anti-chevauchement ═══════════════════════════════════════════════════════
exec 9>"/tmp/tfs-pull-data.lock"
if ! flock -n 9; then
  echo "$(date '+%F %T') [pull-data] Une autre instance tourne — abandon."
  exit 0
fi

echo "$(date '+%F %T') [pull-data] Début — ${WEB_ROOT}"

# ══ Téléchargement atomique d'un asset ═══════════════════════════════════════
# fetch_asset <nom> [chemin_cible]
fetch_asset() {
  local name="$1"
  local dest="${2:-${WEB_ROOT}/${name}}"
  local tmp="${dest}.tmp.$$"
  if curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 280 -o "$tmp" "${BASE}/${name}"; then
    mv -f "$tmp" "$dest"
    chmod 644 "$dest"
    echo "  ✅ ${name} ($(du -h "$dest" | cut -f1))"
    return 0
  else
    rm -f "$tmp"
    echo "  ⚠️  ${name} : échec téléchargement — fichier précédent conservé"
    return 1
  fi
}

# ══ 1. Snapshots critiques (à chaque exécution) ══════════════════════════════
# Ordre = priorité : le payload optimisé de l'accueil d'abord.
fetch_asset "runs_public.json.gz"
fetch_asset "runs_public.json"
fetch_asset "lobby_state.json"
fetch_asset "ranked.json"
fetch_asset "ranked.json.gz"
fetch_asset "teams_public.json.gz"
fetch_asset "teams_public.json"
fetch_asset "dashboard_scores.json"
fetch_asset "dashboard_scores.json.gz"
fetch_asset "dashboard_ranking.json"
fetch_asset "dashboard_player_games.json"
fetch_asset "runs_compact_public.json.gz"
fetch_asset "runs_compact_public.json"
fetch_asset "clans.json"
fetch_asset "news.json"
fetch_asset "sync-players.json"

# ══ 2. Fichiers joueurs (tarball → untar atomique) ═══════════════════════════
PLAYERS_TMP="${WEB_ROOT}/.players-tmp.$$"
if curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 280 -o "/tmp/tfs-players-$$.tar.gz" "${BASE}/player-files.tar.gz"; then
  rm -rf "$PLAYERS_TMP"
  mkdir -p "$PLAYERS_TMP"
  if tar xzf "/tmp/tfs-players-$$.tar.gz" -C "$PLAYERS_TMP"; then
    # Remplacement dossier par dossier (chaque dossier reste atomique)
    for d in player-data player-stats; do
      if [[ -d "${PLAYERS_TMP}/${d}" ]]; then
        rm -rf "${WEB_ROOT}/${d}.old"
        [[ -d "${WEB_ROOT}/${d}" ]] && mv "${WEB_ROOT}/${d}" "${WEB_ROOT}/${d}.old"
        mv "${PLAYERS_TMP}/${d}" "${WEB_ROOT}/${d}"
        rm -rf "${WEB_ROOT}/${d}.old"
        echo "  ✅ ${d}/ ($(ls "${WEB_ROOT}/${d}" | wc -l) fichiers)"
      fi
    done
  else
    echo "  ⚠️  player-files.tar.gz : tar invalide — conservé l'existant"
  fi
  rm -rf "$PLAYERS_TMP" "/tmp/tfs-players-$$.tar.gz"
else
  rm -f "/tmp/tfs-players-$$.tar.gz"
  echo "  ⚠️  player-files.tar.gz : échec — fichiers précédents conservés"
fi

# ══ 3. Fallback lourd : runs.json.gz (max 1×/24 h) ══════════════════════════
# C'est la grosse archive (16 Mo) utilisée seulement si runs_public.json.gz
# est absent. La re-télécharger à chaque cycle serait inutile.
RUNS="${WEB_ROOT}/runs.json.gz"
now=$(date +%s)
age=$(( now - $(stat -c %Y "$RUNS" 2>/dev/null || echo 0) ))
if [[ $age -ge $ARCHIVE_MAX_AGE ]]; then
  fetch_asset "runs.json.gz"
else
  echo "  ℹ️  runs.json.gz à jour (${age}s < 24 h) — ignoré"
fi

echo "$(date '+%F %T') [pull-data] Fin"
