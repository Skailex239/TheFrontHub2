#!/usr/bin/env python3
"""
scripts/add-tutorial-script.py — Add tutorial.min.js script tag to all HTML pages.

Inserts <script src="dist/tutorial.min.js?v=1"></script> before the SW registration
script on every page. The tutorial runs once per visitor (localStorage tracked).
"""
import re
from pathlib import Path

TUTORIAL_SCRIPT = '<script src="dist/tutorial.min.js?v=1"></script>\n'

PAGES = ["index.html", "profile.html", "dashboard.html", "lobby.html", "atlas.html", "tournois.html", "runs.html"]

def add_to_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'tutorial.min.js' in content:
        print(f"  {filepath.name}: déjà présent, skip")
        return False

    # Insérer juste avant le script du SW (qui est sur toutes les pages)
    pattern = r'(<script>\s*\n\s*if \(\'serviceWorker\' in navigator\))'
    m = re.search(pattern, content)
    if m:
        # Insérer le script tutorial AVANT le <script> SW
        new_content = content[:m.start()] + TUTORIAL_SCRIPT + content[m.start():]
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"✓ {filepath.name}: tutorial.min.js ajouté")
        return True
    else:
        # Fallback : insérer avant </body>
        pattern = r'(\s*</body>)'
        m = re.search(pattern, content)
        if m:
            new_content = content[:m.start()] + '\n' + TUTORIAL_SCRIPT + content[m.start():]
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"✓ {filepath.name}: tutorial.min.js ajouté (avant </body>)")
            return True
    print(f"✗ {filepath.name}: pattern non trouvé")
    return False

if __name__ == "__main__":
    root = Path(".")
    count = 0
    for page in PAGES:
        p = root / page
        if p.exists():
            if add_to_file(p):
                count += 1
    print(f"\n{count}/{len(PAGES)} pages mises à jour")
