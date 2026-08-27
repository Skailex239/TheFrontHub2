#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload-to-o2switch.sh — Upload des fichiers de données vers o2switch
#
# Appelé depuis GitHub Actions (workflow sync.yml) après chaque sync.
# Upload chaque fichier via HTTP POST vers _upload.php sur o2switch.
#
# Usage :
#   O2SWITCH_URL="https://thefronthub.com/_upload.php"
#   O2SWITCH_SECRET="xxxxxxxx..."
#   ./upload-to-o2switch.sh snapshot "lobby_state.json" "ranked.json" ...
#   ./upload-to-o2switch.sh archive  "runs.json.gz" "runs_compact.json.gz"
#
# Variables d'environnement requises :
#   O2SWITCH_URL     — URL complète de _upload.php
#   O2SWITCH_SECRET  — Secret partagé (même valeur que le secret résolu par _upload.php)
#
# Sécurité (v2) :
#   Chaque upload est signé en HMAC-SHA256 (header X-Upload-Signature) calculé
#   sur le contenu exact du fichier. _upload.php v2 vérifie la signature.
#   Si openssl est indisponible, on envoie sans signature (le serveur en
#   REQUIRE_SIGNATURE=false l'accepte — compatibilité ascendante).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Validation des vars d'env ──
if [[ -z "${O2SWITCH_URL:-}" ]] || [[ -z "${O2SWITCH_SECRET:-}" ]]; then
  echo "❌ O2SWITCH_URL et O2SWITCH_SECRET doivent être définis"
  exit 1
fi

# ── Args ──
MODE="${1:-snapshot}"
shift
FILES=("$@")

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "ℹ️  Aucun fichier à uploader"
  exit 0
fi

if [[ ! "$MODE" =~ ^(snapshot|archive)$ ]]; then
  echo "❌ Mode invalide: $MODE (doit être 'snapshot' ou 'archive')"
  exit 1
fi

echo "🚀 Upload vers o2switch — mode: $MODE"
echo "   Endpoint: $O2SWITCH_URL"
echo "   Fichiers: ${#FILES[@]}"
echo ""

# Stats
OK=0
FAILED=0
SKIPPED=0

for f in "${FILES[@]}"; do
  # Le chemin local peut avoir des sous-dossiers (ex: player-data/xxx.json)
  if [[ ! -f "$f" ]]; then
    echo "  ⏭️  SKIP (introuvable): $f"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Le nom de fichier cible = chemin relatif à partir de la racine du repo
  # Ex: "player-data/xxx.json" → "player-data/xxx.json"
  RELNAME="$f"

  SIZE=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo "?")

  # Signature HMAC-SHA256 du contenu du fichier (authentifie ET intègre les données)
  SIG_ARGS=()
  if command -v openssl >/dev/null 2>&1; then
    SIG_HEX=$(openssl dgst -sha256 -hmac "$O2SWITCH_SECRET" -r "$f" 2>/dev/null | awk '{print $1}')
    if [[ -n "$SIG_HEX" ]]; then
      SIG_ARGS=(-H "X-Upload-Signature: sha256=$SIG_HEX")
    else
      echo "⚠️  Signature HMAC non calculée pour $f (envoi non signé)"
    fi
  else
    echo "⚠️  openssl absent — envoi non signé pour $f"
  fi

  echo -n "  📤 $RELNAME (${SIZE} bytes)... "

  # URL-encoder le nom de fichier pour la query string (sous-dossiers inclus)
  ENC_NAME=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$RELNAME" 2>/dev/null || echo "$RELNAME")

  # ── Transport principal : BODY BRUT (raw-body) ──
  # ⚠️ Depuis le 26/08/2026, le WAF o2switch (ModSecurity) bloque en 406 tout
  #    POST multipart CONTENANT un fichier — même de 118 octets — ce qui
  #    cassait tout le pipeline (curl error 56 côté GitHub Actions).
  #    Le body brut (Content-Type: application/octet-stream, filename dans
  #    la query string) passe le WAF. Nécessite _upload.php v3+.
  # ⚠️ --http1.1 : obligatoire pour les gros fichiers (>10 Mo) car HTTP/2
  #    a des soucis de flux avec LiteSpeed/o2switch (curl error 92)
  # ⚠️ -H "Expect:" : désactive le handshake 100-continue (LiteSpeed coupe
  #    la connexion pendant l'attente sur les gros corps)
  # ⚠️ --max-time 300 : 5 min pour les gros fichiers (16+ Mo)
  # ⚠️ --retry 5 --retry-delay 15 --retry-all-errors : retries robustes
  RESPONSE=$(curl -sS -X POST \
    --http1.1 \
    --connect-timeout 30 \
    -H "Expect:" \
    -H "X-Upload-Secret: $O2SWITCH_SECRET" \
    ${SIG_ARGS[@]+"${SIG_ARGS[@]}"} \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    --max-time 300 \
    --retry 5 \
    --retry-delay 15 \
    --retry-all-errors \
    "${O2SWITCH_URL}?filename=${ENC_NAME}&mode=${MODE}" 2>&1) || RESPONSE="curl error: $?"

  # ── Fallback multipart (compatibilité ancienne version de _upload.php) ──
  # Si le serveur renvoie "Missing filename"/"Missing file" (400), c'est que
  # _upload.php v3 n'est pas encore déployé → on retente en multipart.
  # (Sur o2switch, le multipart est bloqué par le WAF — ce fallback ne
  #  réussira pas là-bas, mais garde le script portable sur d'autres hosts.)
  if ! echo "$RESPONSE" | grep -q '"ok":true'; then
    if echo "$RESPONSE" | grep -qE '"error":"Missing (file|filename)"'; then
      echo "↪️  Raw-body non supporté (_upload.php < v3) → tentative multipart…"
      RESPONSE=$(curl -sS -X POST \
        --http1.1 \
        --connect-timeout 30 \
        -H "Expect:" \
        -H "X-Upload-Secret: $O2SWITCH_SECRET" \
        ${SIG_ARGS[@]+"${SIG_ARGS[@]}"} \
        -F "file=@$f" \
        -F "filename=$RELNAME" \
        -F "mode=$MODE" \
        --max-time 300 \
        --retry 2 \
        --retry-delay 10 \
        --retry-all-errors \
        "$O2SWITCH_URL" 2>&1) || RESPONSE="curl error: $?"
    fi
  fi

  # Vérifier la réponse JSON
  if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ OK"
    OK=$((OK + 1))
  else
    echo "❌ FAILED"
    echo "      Réponse: $RESPONSE"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "──────────────────────────────────────"
echo "Résultat: $OK OK, $FAILED failed, $SKIPPED skipped"
echo ""

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi

exit 0
