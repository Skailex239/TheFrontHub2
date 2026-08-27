#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# data-release.sh — Transport des données via GitHub Release « data-latest »
#
# ⚠️ CONTEXTE (audit 2026-08-27) : le WAF o2switch coupe les connexions POST
# provenant des IP GitHub Actions / Azure (curl error 56) — même en raw-body,
# même sur des fichiers de 118 octets. Le PUSH HTTP vers _upload.php est donc
# impossible depuis GitHub Actions, quelle que soit la méthode.
#
# SOLUTION : inverser le sens du flux. Les workflows GitHub Actions publient
# les fichiers de données en ASSETS d'une release publique (tag data-latest),
# et le serveur o2switch les PULL via de simples GET (le cron fait déjà un
# git fetch vers github.com toutes les 5 min — les GET fonctionnent).
#
# Usage (dans les workflows ; GH_TOKEN requis pour push) :
#   ./scripts/data-release.sh pull <fichier>...   # GET des assets (404 ignoré)
#   ./scripts/data-release.sh push <fichier>...   # upload assets (clobber),
#                                                 # fichiers absents ignorés
#
# La release est publique (repo public) → le serveur télécharge sans auth :
#   https://github.com/Skailex239/TheFrontHub2/releases/download/data-latest/<fichier>
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="Skailex239/TheFrontHub2"
TAG="data-latest"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

usage() {
  echo "Usage: data-release.sh pull <fichier>..."
  echo "       data-release.sh push <fichier>..."
  exit 1
}

[[ $# -ge 2 ]] || usage
cmd="$1"; shift

case "$cmd" in
  pull)
    # Télécharge chaque asset demandé dans le répertoire courant.
    # 404 = asset pas encore publié → on CONSERVE la copie locale (le repo
    # contient des copies de l'état : mieux que rien au premier cycle).
    for f in "$@"; do
      if curl -fsSL --retry 3 --retry-delay 5 -o "${f}.dl" "${BASE_URL}/${f}"; then
        mv -f "${f}.dl" "$f"
        echo "  ⬇️  ${f} ($(stat -c%s "$f" 2>/dev/null || echo '?') bytes)"
      else
        rm -f "${f}.dl"
        if [[ -f "$f" ]]; then
          echo "  ⏭️  ${f} absent de la release — copie locale conservée ($(stat -c%s "$f") bytes)"
        else
          echo "  ⏭️  ${f} absent (premier cycle, pas de copie locale)"
        fi
      fi
    done
    ;;

  push)
    # Garder uniquement les fichiers existants (les absents sont ignorés)
    FILES=()
    for f in "$@"; do
      if [[ -f "$f" ]]; then
        FILES+=("$f")
      else
        echo "  ⏭️  SKIP (introuvable): $f"
      fi
    done

    if [[ ${#FILES[@]} -eq 0 ]]; then
      echo "  ℹ️  Aucun fichier à publier"
      exit 0
    fi

    # Créer la release si elle n'existe pas, puis uploader (clobber = remplacer)
    if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
      gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber
    else
      gh release create "$TAG" "${FILES[@]}" --repo "$REPO" \
        --title "Data snapshot (auto)" \
        --notes "Instantané des données TheFrontHub — remplacé à chaque cycle Auto Sync. Ne pas supprimer."
    fi
    echo "  ✅ Publié dans la release ${TAG}: ${FILES[*]}"
    ;;

  *)
    usage
    ;;
esac
