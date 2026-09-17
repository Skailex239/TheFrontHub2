#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# upstream-watch.sh — Veille du repo amont OpenFrontIO (Task 13)
#
# OpenFront déploie très souvent (parfois plusieurs fois par jour) et un
# seul commit sur Schemas.ts / Maps.gen.ts / le protocole lobby peut casser
# le lobby preview ou le dashboard. Ce script détecte TOUT changement sur
# les fichiers critiques et écrit un rapport daté.
#
# Usage       : bash scripts/upstream-watch.sh
# Cron o2switch (1×/jour suffit, le script est incrémental) :
#   0 6 * * * bash /home2/mask6607/thefronthub-src/scripts/upstream-watch.sh >> /home2/mask6607/logs/upstream-watch.log 2>&1
# Rapport     : /home2/mask6607/logs/upstream-report.txt (dernier état)
# ══════════════════════════════════════════════════════════════════════
set -u

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

UPSTREAM="https://github.com/openfrontio/OpenFrontIO.git"
WATCHED=(
  "src/core/Schemas.ts"                 # PublicLobbyMessageSchema, GameConfig (zbin !)
  "src/core/game/Maps.gen.ts"           # ordinaux des maps (zbin)
  "src/core/game/Game.ts"               # enums (difficulty, units…)
  "src/core/ZbinWire.ts"                # encodage binaire
  "src/client/LobbySocket.ts"           # connexion lobby du client officiel
  "src/client/ServerList.ts"            # registry cluster.json (hosts/workers)
  "src/client/ClientEnv.ts"             # serverWsBase, numWorkers
  "src/server/WorkerLobbyService.ts"    # endpoint /lobbies côté serveur
  "src/server/MasterLobbyService.ts"    # liste cluster + coordinator
  "docs/MultiServer.md"                 # conventions blue/green, registry
  "docs/API.md"                         # API publique /public/games…
)

WORKDIR="${TMPDIR:-/tmp}/openfrontio-watch"
STATE="$WORKDIR/last-head.txt"
REPORT="${UPSTREAM_REPORT:-${HOME}/logs/upstream-report.txt}"
if [ ! -w "$(dirname "$REPORT")" ] 2>/dev/null; then REPORT="./upstream-report.txt"; fi

mkdir -p "$WORKDIR" "$(dirname "$REPORT")" 2>/dev/null

# 1) Clone ou pull du repo amont (shallow, rapide)
if [ -d "$WORKDIR/.git" ]; then
  git -C "$WORKDIR" fetch origin main --quiet 2>/dev/null || { echo "[$(date '+%F %T')] git fetch échoué"; exit 1; }
  git -C "$WORKDIR" reset --hard origin/main --quiet
else
  git clone --quiet --filter=blob:none "$UPSTREAM" "$WORKDIR" || { echo "[$(date '+%F %T')] clone échoué"; exit 1; }
fi

NEW_HEAD="$(git -C "$WORKDIR" rev-parse HEAD)"
OLD_HEAD="$(cat "$STATE" 2>/dev/null || echo "")"

{
  echo "════ $(date '+%F %T') — OpenFrontIO HEAD $NEW_HEAD"
  if [ -z "$OLD_HEAD" ]; then
    echo "  première exécution : référence enregistrée (pas de diff)"
  elif [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
    echo "  aucun nouveau commit depuis la dernière vérification"
  else
    echo "  ⚠️ $(git -C "$WORKDIR" rev-list --count "$OLD_HEAD..$NEW_HEAD") NOUVEAU(X) COMMIT(S) :"
    git -C "$WORKDIR" log --oneline "$OLD_HEAD..$NEW_HEAD" | head -40
    echo "  ── Fichiers critiques modifiés :"
    for f in "${WATCHED[@]}"; do
      if git -C "$WORKDIR" diff --name-only "$OLD_HEAD..$NEW_HEAD" -- "$f" | grep -q .; then
        echo "    🔴 $f"
      fi
    done
    echo "  ── Détail des diffs critiques (extrait) :"
    for f in "${WATCHED[@]}"; do
      D="$(git -C "$WORKDIR" diff "$OLD_HEAD..$NEW_HEAD" -- "$f" | head -60)"
      if [ -n "$D" ]; then
        echo "    ── $f ──"
        echo "$D" | sed 's/^/    /'
      fi
    done
  fi
  echo
} >> "$REPORT"

echo "$NEW_HEAD" > "$STATE"
# Rapport tronqué (garde ~40 Ko)
tail -c 40000 "$REPORT" > "$REPORT.tmp" 2>/dev/null && mv "$REPORT.tmp" "$REPORT" || true
echo "[$(date '+%F %T')] veille OK — HEAD $NEW_HEAD (rapport : $REPORT)"
