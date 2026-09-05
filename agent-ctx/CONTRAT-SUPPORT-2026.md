# CONTRAT API — Support 2026 (tickets, chat direct, mails) + conventions

À lire par tout agent travaillant sur les vues Support / Admin / Chat.
Backend déjà écrit et FIGÉ : ne modifie JAMAIS `api/chat.php`, `api/support.php`
ni les actions `support.*` / `supchat.*` / `mails.*` de `admin/api.php`.

## 1. Chat joueur → site (api/chat.php) — session Discord obligatoire

| Appel | Réponse |
|---|---|
| `GET /api/chat.php?action=state` | `{ ok, me:{name,avatar}, last_id }` |
| `GET /api/chat.php?action=poll&since=<id>` | `{ ok, me:{name,avatar}, messages:[{id,role,name,body,created_at}], last_id }` — `role` = `"user"|"admin"` |
| `POST /api/chat.php` `{action:"send", content:"..."}` | `{ ok, message:{id,role:"user",name,body,created_at} }` |

Erreurs : 401 `{ok:false,error:"auth_required"}` (non connecté), 403 `no_identity`.
Polling recommandé : toutes les 2,5 s quand le panneau est ouvert ; 20 s quand fermé
(uniquement last_id pour badge) — ou pas de polling fermé (simplification acceptée).

## 2. Admin — mêmes origine/session que le panel (CSRF obligatoire en POST)

Base : `GET/POST api.php` relatif à la page admin (`task_base_path()`).
Tous les POST JSON nécessitent l'en-tête `X-CSRF-Token` (token = `TASK_BOOT.csrf`,
helper existant `apiFetch()` dans admin/assets/app.js — RÉUTILISE-le).

### GET
| Appel | Réponse |
|---|---|
| `?action=support.tickets[&status=open|closed]` | `{ ok, tickets:[{id,user_id,user_name,user_avatar,category,subject,status,messages,last_role,preview,created_at,updated_at}], open_count }` — status ∈ `open|answered|closed` |
| `?action=support.thread&id=<ticketId>` | `{ ok, ticket:{id,user_id,user_name,category,subject,status,created_at,updated_at}, messages:[{id,author_role:"user"|"team",author_name,author_avatar,body,created_at}] }` |
| `?action=supchat.convs` | `{ ok, convs:[{conv_id,name,avatar,unread,total,last_role,last_body,last_at}] }` |
| `?action=supchat.poll&conv=<discordId>&after=<id>` | `{ ok, messages:[{id,role:"user"|"admin",name,body,created_at}], last_id }` — marque lus côté admin |
| `?action=mails.list` | `{ ok, available:true, mailbox, total, mails:[{uid,from,subject,date,ts,seen,answered,size}] }` OU `{ ok, available:false, reason:"not_configured"|"imap_unavailable"|"login_failed", hint }` |
| `?action=mails.view&uid=<uid>` | `{ ok, mail:{uid,from,subject,date,message_id,body} }` (texte brut dégrossi) |

### POST (JSON + X-CSRF-Token)
| Action | Body | Réponse |
|---|---|---|
| `support.reply` | `{ticket_id, message}` | `{ok,status:"answered"}` (+ mail auto au joueur) |
| `support.close` | `{ticket_id}` | `{ok,status:"closed"}` |
| `supchat.reply` | `{conv, content}` | `{ok,id}` |
| `mails.reply` | `{to, subject, body, in_reply_to?}` | `{ok}` (envoi réel via mail(), From support@thefronthub.com) |

Statuts tickets : `open` (attente équipe) → `answered` (équipe a répondu) → `closed`.
Le joueur relançant sur un ticket `answered` le repasse `open` (côté site).

## 3. Conventions UI site public (support.html)

- Rendu support dans `#support-view` par support.js (gate si non connecté).
- Lien Discord officiel : `https://discord.gg/AZhmqRvbNh` (déjà dans le footer).
- Mail support : `support@thefronthub.com`.
- Le chat utilisateur = widget global bulle `window.TfhChatWidget` (agent 4-c) ;
  la page Support affiche juste un bouton « Ouvrir le chat » → `window.TfhChatWidget?.open()`.
- CSS site : variables `var(--accent)` (orange), `var(--card)`, `var(--border)`, `var(--fg)`, `var(--radius)`, classes existantes `.sup-*` dans support.css. Sombre : `:root[data-theme="dark"]`.
- Icônes : inline SVG 24×24 stroke (style lucide), comme dans le footer.
- Accessibilité : aria-label sur boutons, focus-visible, contrastes ok, cibles tactiles ≥40px.
- Mobile-first : le support est consulté sur téléphone → tout empilable <768px.

## 4. Conventions UI admin (admin/index.php)

- Design tokens : CSS custom properties définies dans admin/assets/style.css (`--bg`, `--card`, `--border`, `--accent`, `--radius`…). Thème sombre par défaut + toggle clair.
- `TASK_BOOT` global : `{ base, csrf, me:{id,name,avatar,can_manage} }`.
- `apiFetch(action, body)` existe déjà (POST JSON + CSRF) ; GET = fetch direct `api.php?action=...`.
- Toasts : fonction `toast(msg, type)` existante.
- L'admin est visité sur desktop ET mobile → la sidebar doit devenir un drawer/hamburger <900px.

## 5. Mock serveur local (pour tester sans MySQL/PHP)

`bun /tmp/tfh-mock/server.mjs` → sert le repo sur http://localhost:8788 avec les
endpoints `/api/*` et `/admin/api.php` mockés (JSON déterministes). Voir le
fichier pour la liste. Les sessions sont simulées : `TestJoueur` connecté.
Le mock sert les fichiers sources à la racine (styles.css, support.js, dist/…).
