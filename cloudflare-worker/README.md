# Cloudflare Worker — OpenFront Proxy

Proxy CORS vers l'API OpenFront avec exemption Skailex (token côté serveur).

## Pourquoi ?

L'API OpenFront (`api.openfront.io`) n'autorise CORS que depuis `openfront.io`.
Les requêtes depuis `skailex239.github.io` sont bloquées par le navigateur.

Ce Worker agit comme proxy :
- Ajoute le header `x-skailex-access` côté serveur (token **non exposé** dans le JS client)
- Ajoute les headers CORS permissifs (`Access-Control-Allow-Origin: *`)
- Forward la requête vers `https://api.openfront.io/<path>`

## Déploiement (2 min, gratuit)

### Étape 1 — Créer un compte Cloudflare
1. Aller sur https://dash.cloudflare.com/sign-up
2. Créer un compte gratuit (pas besoin de carte bancaire)

### Étape 2 — Créer le Worker
1. Dans le dashboard → **Workers & Pages** → **Create application**
2. Cliquer **Create Worker**
3. Nommer le worker : `openfront-proxy`
4. Cliquer **Deploy**
5. Cliquer **Edit code**
6. **Effacer** le code par défaut dans `worker.js`
7. **Coller** le contenu de `openfront-proxy.js` (ce dossier)
8. Cliquer **Save and deploy**

### Étape 3 — Récupérer l'URL du Worker
L'URL sera de la forme :
```
https://openfront-proxy.<votre-sous-domaine>.workers.dev
```
Exemple : `https://openfront-proxy.diofortnite3.workers.dev`

### Étape 4 — Configurer le dashboard
Dans `public/dashboard.html`, ajouter/modifier la balise meta :
```html
<meta name="openfront-api-proxy" content="https://openfront-proxy.<votre-sous-domaine>.workers.dev">
```

### Étape 5 — Tester
Ouvrir le dashboard. Les stats des joueurs connectés se chargent en live depuis l'API.

## Limites du plan gratuit

- **100 000 requêtes/jour** — largement suffisant (le dashboard fait ~6 joueurs × ~200 pages = 1200 req/chargement, avec cache localStorage 30 min)
- **10 ms CPU par requête** — OK pour un simple proxy
- Pas de limite de bande passante

## Sécurité

Le token `x-skailex-access` est **hardcodé dans le Worker** côté serveur.
Il n'apparaît **jamais** dans le code client (browser).
Personne ne peut le voler en inspectant le JS du site.

## Test manuel

```bash
# Test direct (depuis n'importe où)
curl "https://openfront-proxy.<votre-sous-domaine>.workers.dev/public/player/UWetOwlW/games"

# Doit retourner du JSON :
# {"results":[...],"nextCursor":"..."}
```
