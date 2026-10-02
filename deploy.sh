#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# TheFrontHub — deploy.sh : déploiement git -> webroot (cron + manuel)
#
# Usage    : bash /home2/mask6607/thefronthub-src/deploy.sh
# Cron     : */5 * * * * bash /home2/mask6607/thefronthub-src/deploy.sh
# Logs     : /home2/mask6607/logs/deploy.log
#
# Remplace la longue commande cron historique par un script versionné
# dans le repo (auto-mis-a-jour par son propre git reset) :
#   - PATH explicite (les cron cPanel ont un PATH minimal : cause n.1
#     d'echec de "git: command not found")
#   - log horodate (plus jamais d'echec silencieux)
#   - garde-fou auto-mise-a-jour : execution depuis une copie figee,
#     car le git reset peut remplacer ce fichier pendant son execution
# ══════════════════════════════════════════════════════════════════════

set -u

# ── Garde-fou auto-mise-a-jour ─────────────────────────────────────────
# bash lit les scripts par blocs ; si `git reset --hard` remplace ce
# fichier en cours d'execution, la suite de la lecture peut etre
# tronquee. On s'execute donc depuis une copie figee dans /tmp.
if [ "${TFH_DEPLOY_REEXEC:-0}" != "1" ]; then
  _tmp="$(mktemp /tmp/tfh-deploy.XXXXXX 2>/dev/null)" || _tmp=""
  if [ -n "$_tmp" ]; then
    cat "$0" > "$_tmp"
    TFH_DEPLOY_REEXEC=1 bash "$_tmp" "$@"
    _rc=$?
    rm -f "$_tmp"
    exit $_rc
  fi
  # mktemp indisponible -> on continue quand meme (risque minimal)
fi

# ── Configuration ──────────────────────────────────────────────────────
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:${PATH:-}"

SRC="/home2/mask6607/thefronthub-src"
DEST="/home2/mask6607/public_html/thefronthub.com"
LOGDIR="/home2/mask6607/logs"
LOG="$LOGDIR/deploy.log"

mkdir -p "$LOGDIR" 2>/dev/null
ts() { date '+%F %T'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }
die() { log "ECHEC: $*"; echo "ECHEC: $* (voir $LOG)"; exit 1; }

log "── demarrage deploiement ──"

# ── 1) git : fetch + reset (le clone est public, aucun token requis) ──
cd "$SRC" || die "dossier source introuvable : $SRC"
git fetch origin main >> "$LOG" 2>&1 || die "git fetch a echoue"
git reset --hard origin/main >> "$LOG" 2>&1 || die "git reset a echoue"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
log "git OK -> commit $COMMIT"

# ── 2) rsync : clone git -> webroot ────────────────────────────────────
# /.htaccess ancre a la racine : protege le .htaccess racine ET
# api/.htaccess (durcissement), qui sont geres manuellement serveur.
# deploy.sh est exclu : script serveur, jamais servi publiquement.
#
# NB (fix 2026-08-29) : les regles --include AVANT --exclude='*.json'
# re-tablissent le deploiement des JSON du site (data/*.json,
# data/tournaments/*.json, atlas-data/maps_data.json) que l'exclusion
# globale *.json bloquait depuis l'inversion du flux de donnees.
# Les JSON de SYNC a la racine (lobby_state.json, ranked.json, runs*.gz…)
# restent exclus : ils sont ecris par pull-data.sh et l'exclusion les
# protege aussi du --delete rsync (jamais ecrases par le clone git).
rsync -a --delete \
  --exclude='.git' \
  --exclude='/.htaccess' \
  --exclude='_upload.php' \
  --exclude='_deploy.php' \
  --exclude='_archives' \
  --exclude='games-sync.log' \
  --include='/data/' \
  --include='/data/**' \
  --include='/atlas-data/maps_data.json' \
  --include='/atlas-data/world-110m.topojson' \
  --exclude='*.json' \
  --exclude='*.json.gz' \
  --exclude='player-data' \
  --exclude='player-stats' \
  --exclude='src' \
  --exclude='tests' \
  --exclude='scripts' \
  --exclude='.github' \
  --exclude='.trae' \
  --exclude='.windsurf' \
  --exclude='.zscripts' \
  --exclude='prisma' \
  --exclude='db' \
  --exclude='examples' \
  --exclude='mini-services' \
  --exclude='cloudflare-worker' \
  --exclude='agent-ctx' \
  --exclude='worklog.md' \
  --exclude='GUIDE_*.md' \
  --exclude='public' \
  --exclude='node_modules' \
  --exclude='package.json' \
  --exclude='package-lock.json' \
  --exclude='bun.lock' \
  --exclude='tsconfig.json' \
  --exclude='next.config.ts' \
  --exclude='tailwind.config.ts' \
  --exclude='postcss.config.mjs' \
  --exclude='eslint.config.mjs' \
  --exclude='pull-data.sh' \
  --exclude='deploy.sh' \
  ./ "$DEST/" >> "$LOG" 2>&1 || die "rsync a echoue"
log "rsync OK"

# ── 3) permissions (identique a l'ancien cron) ─────────────────────────
find "$DEST" -type d -exec chmod 755 {} \; >> "$LOG" 2>&1 \
  || log "avertissement : chmod dossiers"
find "$DEST" -type f -exec chmod 644 {} \; >> "$LOG" 2>&1 \
  || log "avertissement : chmod fichiers"

# ── 4) donnees JSON (pull-data.sh, log dedie) ──────────────────────────
if [ -f "$SRC/pull-data.sh" ]; then
  if bash "$SRC/pull-data.sh" >> "$LOGDIR/pull-data.log" 2>&1; then
    log "pull-data OK"
  else
    log "avertissement : pull-data a echoue (voir pull-data.log)"
  fi
else
  log "avertissement : pull-data.sh introuvable"
fi

# ── 5) NOUVEAU DEPART speedruns (2026-09-23) ──────────────────────────
# a) Nettoyage de l'ancien store statique (153 321 runs sans publicId
#    fiable) : la page speedruns lit la DB (/api/games-api.php) et
#    l'accueil lit le payload régénéré ci-dessous.
if [ -f "$DEST/runs.json.gz" ] || [ -f "$DEST/runs.json" ]; then
  rm -f "$DEST/runs.json.gz" "$DEST/runs.json"
  log "cleanup : ancien runs.json.gz / runs.json supprimé du webroot"
fi
# b) Régénération LOCALE des payloads speedruns (runs_public*,
#    runs_compact_public*) depuis MySQL (tables tfh_g_* remplies par
#    api/games-sync.php) — remplace la release GitHub « data-latest ».
if [ -x /usr/local/bin/php ] && [ -f "$DEST/api/games-export.php" ]; then
  if /usr/local/bin/php "$DEST/api/games-export.php" >> "$LOGDIR/games-export.log" 2>&1; then
    log "games-export OK"
  else
    log "avertissement : games-export a echoue (voir games-export.log)"
  fi
else
  log "avertissement : games-export indisponible (php ou script manquant)"
fi

# ── 6) DÉPLOIEMENT DEV (branche dev → dev.thefronthub.com) ─────────────
# Environnement de pré-production : la branche `dev` est déployée vers le
# sous-domaine dev.thefronthub.com (créé UNE FOIS dans cPanel, document root
# /home2/mask6607/dev.thefronthub.com). Zéro cron supplémentaire : ce script
# gère les deux cibles à chaque tick.
#   - Même base MySQL (le front lit la même data que la prod).
#   - Mêmes secrets (~/.tfs_secrets, hors webroot, chargés par api/config.php).
#   - Les JSON de sync (ranked.json, lobby_state.json, runs_public…) sont des
#     SYMLINKS vers le webroot prod : toujours à jour, zéro duplication.
#     (--exclude protège aussi ces symlinks du --delete rsync.)
#   - Si la branche dev n'existe pas sur origin : étape ignorée, prod intacte.
#   - dev est noindex (robots.txt Disallow + en-tête X-Robots-Tag).
DEV_SRC="/home2/mask6607/thefronthub-dev"
DEV_DEST="/home2/mask6607/dev.thefronthub.com"
DEV_URL="https://github.com/Skailex239/TheFrontHub2.git"

if git ls-remote --heads origin dev 2>/dev/null | grep -q "refs/heads/dev"; then
  log "── deploiement DEV (branche dev) ──"
  if [ ! -d "$DEV_SRC/.git" ]; then
    git clone --branch dev --single-branch "$DEV_URL" "$DEV_SRC" >> "$LOG" 2>&1 \
      || log "avertissement : clone dev a echoue"
  fi
  if [ -d "$DEV_SRC/.git" ]; then
    cd "$DEV_SRC" \
      && git fetch origin dev >> "$LOG" 2>&1 \
      && git reset --hard origin/dev >> "$LOG" 2>&1 \
      || log "avertissement : maj git dev a echoue"
    DEVCOMMIT="$(git -C "$DEV_SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"
    mkdir -p "$DEV_DEST"
    rsync -a --delete \
      --exclude='.git' \
      --exclude='/.htaccess' \
      --exclude='_upload.php' \
      --exclude='_deploy.php' \
      --exclude='_archives' \
      --exclude='games-sync.log' \
      --include='/data/' \
      --include='/data/**' \
      --include='/atlas-data/maps_data.json' \
      --include='/atlas-data/world-110m.topojson' \
      --exclude='*.json' \
      --exclude='*.json.gz' \
      --exclude='player-data' \
      --exclude='player-stats' \
      --exclude='src' \
      --exclude='tests' \
      --exclude='scripts' \
      --exclude='.github' \
      --exclude='.trae' \
      --exclude='.windsurf' \
      --exclude='.zscripts' \
      --exclude='prisma' \
      --exclude='db' \
      --exclude='examples' \
      --exclude='mini-services' \
      --exclude='cloudflare-worker' \
      --exclude='agent-ctx' \
      --exclude='worklog.md' \
      --exclude='GUIDE_*.md' \
      --exclude='STAGING.md' \
      --exclude='public' \
      --exclude='node_modules' \
      --exclude='package.json' \
      --exclude='package-lock.json' \
      --exclude='bun.lock' \
      --exclude='tsconfig.json' \
      --exclude='next.config.ts' \
      --exclude='tailwind.config.ts' \
      --exclude='postcss.config.mjs' \
      --exclude='eslint.config.mjs' \
      --exclude='pull-data.sh' \
      --exclude='deploy.sh' \
      ./ "$DEV_DEST/" >> "$LOG" 2>&1 || log "avertissement : rsync dev a echoue"
    # .htaccess : la version du repo est sûre pour dev (redirection https://%{HTTP_HOST},
    # aucun domaine codé en dur) + noindex pour ne pas indexer la pré-production.
    if [ -f "$DEV_SRC/.htaccess" ]; then
      cp "$DEV_SRC/.htaccess" "$DEV_DEST/.htaccess" 2>/dev/null \
        || log "avertissement : cp htaccess dev"
      if ! grep -q "X-Robots-Tag" "$DEV_DEST/.htaccess" 2>/dev/null; then
        printf '\n# DEV : pre-production jamais indexee\n<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n' >> "$DEV_DEST/.htaccess"
      fi
    fi
    # robots.txt dev : interdire tout crawl
    printf 'User-agent: *\nDisallow: /\n' > "$DEV_DEST/robots.txt" 2>/dev/null
    # JSON de sync : symlinks vers le webroot prod (toujours a jour)
    for f in "$DEST"/*.json "$DEST"/*.json.gz; do
      [ -e "$f" ] || continue
      ln -sfn "$f" "$DEV_DEST/$(basename "$f")" 2>/dev/null
    done
    for d in player-data player-stats; do
      [ -d "$DEST/$d" ] && ln -sfn "$DEST/$d" "$DEV_DEST/$d" 2>/dev/null
    done
    log "DEV OK -> commit $DEVCOMMIT"
  fi
else
  log "pas de branche dev sur origin — etape DEV ignoree"
fi

log "SUCCES deploiement $COMMIT"
echo "SUCCES deploiement $COMMIT (details : $LOG)"
