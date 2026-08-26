# Comment vider les 5Go sans perdre tes runs

## Le problème
Ton repo fait 5Go car tu as commité pendant des mois :
- `runs.json.gz` (16Mo x 100 commits = 1.6Go)
- `seen.json` (6.7Mo x 100 = 670Mo)
- `runs_compact.json.gz`, `ranked_history.json`, etc.

Chaque commit garde une copie. Même si tu les supprimes maintenant, l'historique les garde.

## La solution : tu gardes les données, mais HORS git

Tes runs ne doivent PLUS être dans git. Elles doivent être :
1. **En local sur ton PC** (backup)
2. **Sur o2switch** (produit par la sync quotidienne)
3. **Dans git : seulement les 2 petits fichiers publics 82Ko**

### Méthode A : Clean radical (recommandée si tu es seul sur le repo) - 5 min

C'est ce que j'ai fait dans `tracker_clean/` (3.3Mo au lieu de 38Mo).

**Sur ton PC Windows :**

```powershell
# 1. Va dans ton repo actuel
cd C:\Users\Toi\Desktop\TheFrontStats-clean

# 2. SAUVEGARDE tes données lourdes (très important)
mkdir C:\BackupFrontStats
copy runs.json.gz C:\BackupFrontStats\
copy runs_compact.json.gz C:\BackupFrontStats\
copy seen.json C:\BackupFrontStats\
copy seen_compact.json C:\BackupFrontStats\
copy ranked_history.json C:\BackupFrontStats\
copy ranked.json C:\BackupFrontStats\

# 3. Crée une branche orpheline vide (sans historique)
git checkout --orphan clean-main
git rm -rf .

# 4. Copie seulement les fichiers légers (source code + public 82Ko)
# Tu peux copier tout depuis tracker_clean que je t'ai préparé
# ou manuellement: tu gardes index.html, app.js, styles.css, etc. + runs_public.json.gz

# 5. Crée le .gitignore (celui que j'ai mis dans tracker_clean)
# Il bloque automatiquement les gros fichiers

# 6. Premier commit propre
git add .
git commit -m "Clean: repo passe de 5Go à 3Mo, data lourde hors git"

# 7. Remplace main par clean-main
git branch -D main
git branch -m clean-main main
git push -f origin main
```

**Résultat :** ton repo GitHub passe de 5Go à 3Mo. Historique vierge. Zéro perte : tes runs sont dans `C:\BackupFrontStats`.

### Méthode B : Chirurgicale (garde l'historique des commits code)

Si tu veux garder l'historique des commits mais supprimer seulement les gros blobs :

Installe `git-filter-repo` :
```bash
pip install git-filter-repo
```

```bash
# 1. Clone miroir
git clone --mirror https://github.com/Skailex239/TheFrontStats-clean.git
cd TheFrontStats-clean.git

# 2. Supprime les gros fichiers de TOUT l'historique
git filter-repo --strip-blobs-bigger-than 1M --force

# 3. Ou plus précis:
git filter-repo --path-glob "seen*.json" --path runs.json.gz --path runs_compact.json.gz --path ranked_history.json --invert-paths --force

# 4. Push force
git push --force --mirror
```

### Après le nettoyage : où vont les runs ?

**Sur o2switch, tu fais :**

1. Upload `C:\BackupFrontStats\seen.json` et `seen_compact.json` dans `/home/tonuser/app/` (une fois)
2. Tu mets `runs_public.json.gz` et `runs_compact_public.json.gz` dans `/public_html/` (ils seront regénérés chaque jour)
3. Tu crées cron :
```
# toutes les 10 min : sync récente
*/10 * * * * cd /home/tonuser/app && /usr/bin/node sync.js recent >> sync.log 2>&1

# toutes les heures : ranked
0 * * * * cd /home/tonuser/app && /usr/bin/node sync-ranked.js >> sync.log 2>&1

# 1 fois par jour : copie le public payload vers le site
5 * * * * cp /home/tonuser/app/runs_public.json.gz /home/tonuser/public_html/ && cp /home/tonuser/app/runs_compact_public.json.gz /home/tonuser/public_html/
```

Même si tu perds `seen.json`, ce n'est pas grave :
- `runs.json` garde tous les runs déjà trouvés (tu as backup)
- `seen` évite juste de re-télécharger des games déjà vues. Sans lui, la sync va juste re-scraper un peu plus lentement pendant 1-2 jours puis le reconstruire.

### Check : comment savoir que c'est propre ?

```bash
git count-objects -vH
# Avant : size-pack: 5.12 GiB
# Après : size-pack: 2.30 MiB

git rev-list --objects --all | sort -k2 | grep -E "json.gz|seen"
# doit retourner RIEN
```

### Ce que je t'ai préparé dans ce workspace

Dans `/home/user/tracker_clean/` tu as déjà la version clean (3.3Mo) :
- .gitignore pro
- seulement runs_public.json.gz (82Ko) + runs_compact_public.json.gz (83Ko) + ranked.json.gz (3Ko) gardés
- tout le code source

Tu peux télécharger ce dossier et le pousser en force sur GitHub pour remplacer instantanément ton repo.

Tu veux que je te génère le script PowerShell `clean.ps1` à double-cliquer sur ton PC ?
