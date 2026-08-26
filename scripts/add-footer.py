#!/usr/bin/env python3
"""
scripts/add-footer.py — Add a common footer to all HTML pages.

Inserts a <footer class="tfh-footer"> just before </body> on every page.
The footer includes:
  - Brand + tagline
  - Discord link (https://discord.gg/AZhmqRvbNh)
  - Navigation links (Speedruns, Classé, Tournois, Atlas, Lobby, Dashboard)
  - GitHub link
  - Copyright

The footer is OUTSIDE .app so it appears at the bottom of the scrollable
content (not fixed). It adapts to mobile via CSS (1 column on mobile).
"""
import re
import sys
from pathlib import Path

FOOTER_HTML = """
<!-- ═══ FOOTER (commun à toutes les pages) ═══ -->
<footer class="tfh-footer">
  <div class="tfh-footer-container">
    <div class="tfh-footer-col tfh-footer-brand">
      <a href="index.html" class="tfh-footer-logo">
        <img src="TheFrontHub Logo Text.png" alt="TheFrontHub" loading="lazy">
      </a>
      <p class="tfh-footer-tagline">Le hub ultime pour OpenFront.io — speedruns, classements, tournois et stats joueurs.</p>
      <a href="https://discord.gg/AZhmqRvbNh" target="_blank" rel="noreferrer" class="tfh-footer-discord">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
        <span>Rejoindre le Discord</span>
      </a>
    </div>

    <div class="tfh-footer-col">
      <h4 class="tfh-footer-title">Navigation</h4>
      <ul class="tfh-footer-links">
        <li><a href="index.html">Speedruns</a></li>
        <li><a href="index.html?tab=ranked">Classé</a></li>
        <li><a href="dashboard.html">Tableau de bord</a></li>
        <li><a href="tournois.html">Tournois</a></li>
        <li><a href="atlas.html">Atlas</a></li>
        <li><a href="lobby.html">Lobby</a></li>
      </ul>
    </div>

    <div class="tfh-footer-col">
      <h4 class="tfh-footer-title">Joueur</h4>
      <ul class="tfh-footer-links">
        <li><a href="profile.html">Mon profil</a></li>
        <li><a href="https://openfront.io" target="_blank" rel="noreferrer">Jouer à OpenFront ↗</a></li>
      </ul>
    </div>
  </div>

  <div class="tfh-footer-bottom">
    <p>© <span id="tfh-current-year">2026</span> TheFrontHub. Non affilié à OpenFront.io.</p>
    <p class="tfh-footer-made">Fait avec <span class="tfh-heart">♥</span> par la communauté</p>
  </div>
</footer>

<script>
  // Update copyright year automatically
  (function(){
    var y = new Date().getFullYear();
    var el = document.getElementById('tfh-current-year');
    if (el) el.textContent = y;
  })();
</script>

"""

PAGES = ["index.html", "profile.html", "dashboard.html", "lobby.html", "atlas.html", "tournois.html", "runs.html"]

def add_footer_to_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'class="tfh-footer"' in content:
        print(f"  {filepath.name}: footer déjà présent, skip")
        return False

    # Insert before </body>
    pattern = r'(\s*</body>)'
    m = re.search(pattern, content)
    if not m:
        print(f"  {filepath.name}: </body> non trouvé")
        return False

    new_content = content[:m.start()] + FOOTER_HTML + content[m.start():]
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"✓ {filepath.name}: footer ajouté")
    return True

if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    count = 0
    for page in PAGES:
        p = root / page
        if p.exists():
            if add_footer_to_file(p):
                count += 1
    print(f"\n{count}/{len(PAGES)} pages mises à jour")
