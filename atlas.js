// atlas.js — Atlas interactif des cartes OpenFront
// Reprend la structure de openfront-atlas en vanilla JS
// Carte SVG mondiale (chaque pays = 1 path séparé) + pins + page détail

const ATLAS_VIEW = document.getElementById("atlas-view");
let mapsData = null;
let activeFilter = "all";

const CATEGORIES = [
  { key: "all", label: "Toutes" },
  { key: "continental", label: "Continentales" },
  { key: "regional", label: "Régionales" },
  { key: "fantasy", label: "Autres mondes" },
  { key: "arcade", label: "Arcade" },
  { key: "tournament", label: "Tournoi" },
];

const CAT_COLORS = {
  continental: "#06b6d4", regional: "#34d399", fantasy: "#a855f7",
  arcade: "#facc15", tournament: "#ff7a00",
};

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Échappement pour attribut HTML contenant du JS (onerror="this.src='…'") :
// le navigateur décode les entités AVANT d'exécuter le JS — escapeHtml seul
// ne suffit donc pas. Sérialisation JSON + échappement HTML = round-trip sûr.
function jsq(v) {
  return escapeHtml(JSON.stringify(String(v ?? "")));
}
function getThumbUrl(slug) { return `atlas-data/thumbnails/${slug}.webp`; }
function getMapUrl(slug) { return `atlas-data/maps/${slug}.webp`; }
function getFlagUrl(flag) { return `atlas-data/flags/${flag}.svg`; }

function projectEq(lng, lat, w, h) {
  return [((lng + 180) / 360) * w, ((90 - lat) / 180) * h];
}

// Use d3-geo for proper projection (handles antimeridian, etc.)
function createProjection(width, height) {
  if (window.d3 && window.d3.geoEquirectangular) {
    return window.d3.geoEquirectangular()
      .scale(width / 6.283)
      .translate([width / 2, height / 2])
      .clipExtent([[0, 0], [width, height]]);
  }
  return null;
}

function geoToPath(feature, width, height) {
  // Use d3.geoPath if available (proper projection)
  if (window.d3 && window.d3.geoPath) {
    const projection = createProjection(width, height);
    if (projection) {
      const pathGen = window.d3.geoPath(projection);
      // Use the full geometry (all rings) not just the outer ring
      const d = pathGen(feature);
      return d || "";
    }
  }
  // Fallback: manual equirectangular — process ALL rings (outer + holes)
  const coords = feature.geometry.coordinates;
  const projectRing = (ring) => ring.map(([lng, lat]) => {
    const [x, y] = projectEq(lng, lat, width, height);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  if (feature.geometry.type === "Polygon")
    return coords.map(ring => "M" + projectRing(ring).join(" L") + "Z").join(" ");
  if (feature.geometry.type === "MultiPolygon")
    return coords.map(poly => poly.map(ring => "M" + projectRing(ring).join(" L") + "Z").join(" ")).join(" ");
  return "";
}

async function loadWorldMap() {
  try {
    const res = await fetch(GEO_URL);
    if (!res.ok) return null;
    const topo = await res.json();
    if (window.topojson && window.topojson.feature) {
      const fc = window.topojson.feature(topo, topo.objects.countries || Object.values(topo.objects)[0]);
      return fc.features || [fc];
    }
    return null;
  } catch { return null; }
}

async function loadAtlas() {
  try {
    const [mapsRes, worldFeatures] = await Promise.all([
      fetch("atlas-data/maps_data.json", { cache: "force-cache" }), loadWorldMap()
    ]);
    if (!mapsRes.ok) throw new Error(`HTTP ${mapsRes.status}`);
    mapsData = await mapsRes.json();
    window._atlasWorldFeatures = worldFeatures;
    render();
  } catch (e) {
    ATLAS_VIEW.innerHTML = `<div class="atlas-error"><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function render() {
  if (!mapsData) return;
  const maps = Object.entries(mapsData).map(([slug, data]) => ({ slug, ...data }));
  const filtered = activeFilter === "all" ? maps : maps.filter(m => m.category === activeFilter);
  const totalMaps = maps.length;
  const earthMaps = maps.filter(m => m.category === "continental" || m.category === "regional").length;
  const fantasyMaps = maps.filter(m => m.category === "fantasy").length;
  const arcadeMaps = maps.filter(m => m.category === "arcade" || m.category === "tournament").length;
  const geoMaps = filtered.filter(m => m.geo_lat != null && m.geo_lng != null);
  const worldFeatures = window._atlasWorldFeatures;
  const MAP_W = 980, MAP_H = 490;

  // Each country = separate <path> (fixes the border issue)
  // Filter out countries that cause horizontal lines (span the full longitude range)
  let countryPaths = "";
  if (worldFeatures) {
    countryPaths = worldFeatures.map(f => {
      // Only skip Antarctica (causes a line at the bottom wrapping -90°)
      if (f.id === "ATA" || (f.properties && f.properties.name === "Antarctica")) return "";

      const d = geoToPath(f, MAP_W, MAP_H);
      return d ? `<path d="${d}" />` : "";
    }).join("");
  }

  ATLAS_VIEW.innerHTML = `
    <div class="atlas-intro">
      <p class="atlas-intro-sub">Explorez les ${totalMaps} cartes d'OpenFront — géographie réelle, mondes fantastiques et arcade. Cliquez sur une carte pour les détails, nations et stratégies.</p>
    </div>
    <div class="atlas-stats">
      <div class="atlas-stat"><span class="atlas-stat-val">${totalMaps}</span><span class="atlas-stat-label">Cartes totales</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${earthMaps}</span><span class="atlas-stat-label">Terre</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${fantasyMaps}</span><span class="atlas-stat-label">Autres mondes</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${arcadeMaps}</span><span class="atlas-stat-label">Arcade/Tournoi</span></div>
    </div>
    <div class="atlas-filters">
      ${CATEGORIES.map(c => `<button class="atlas-filter-btn ${c.key === activeFilter ? "active" : ""}" data-cat="${c.key}">${c.label}</button>`).join("")}
    </div>
    ${geoMaps.length > 0 && countryPaths ? `
    <div class="atlas-map-wrap">
      <svg class="atlas-map-svg" viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid meet">
        <rect width="${MAP_W}" height="${MAP_H}" fill="#a8d5e8" />
        <g class="atlas-countries">${countryPaths}</g>
        <g class="atlas-pins">
          ${geoMaps.map(m => {
            const _proj = createProjection(MAP_W, MAP_H);
            let x, y;
            if (_proj) { [x, y] = _proj([m.geo_lng, m.geo_lat]); }
            else { [x, y] = projectEq(m.geo_lng, m.geo_lat, MAP_W, MAP_H); }
            const color = CAT_COLORS[m.category] || "#ff7a00";
            const isContinent = m.geo_type === "continent";
            const r = isContinent ? 7 : 4;
            return `<g class="atlas-svg-pin" data-slug="${m.slug}" style="cursor:pointer">
              <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 5}" fill="${color}" fill-opacity="0.1" />
              <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1" stroke-opacity="0.3" />
              ${isContinent ? `<text x="${x.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="9" font-weight="600" style="pointer-events:none">${escapeHtml(m.translated_name || m.display_name)}</text>` : ""}
            </g>`;
          }).join("")}
        </g>
      </svg>
      <div class="atlas-map-legend">
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#06b6d4"></span> Continental</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#34d399"></span> Régional</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#a855f7"></span> Fantasy</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#facc15"></span> Arcade</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#ff7a00"></span> Tournoi</span>
      </div>
    </div>` : ""}
    <div class="atlas-grid">
      ${filtered.map(m => renderMapCard(m)).join("")}
    </div>
  `;

  ATLAS_VIEW.querySelectorAll(".atlas-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => { activeFilter = btn.dataset.cat; render(); });
  });

  // Pin hover → tooltip
  let tooltipEl = null;
  ATLAS_VIEW.querySelectorAll(".atlas-svg-pin").forEach(pin => {
    pin.addEventListener("mouseenter", (e) => {
      const slug = pin.dataset.slug;
      const m = { slug, ...mapsData[slug] };
      if (!tooltipEl) { tooltipEl = document.createElement("div"); tooltipEl.className = "atlas-tooltip"; document.body.appendChild(tooltipEl); }
      tooltipEl.innerHTML = `
        <img src="${escapeHtml(getThumbUrl(slug))}" alt="${escapeHtml(m.translated_name || m.display_name)}" onerror="this.style.display='none'">
        <div class="atlas-tooltip-name">${escapeHtml(m.translated_name || m.display_name)}</div>
        <div class="atlas-tooltip-stats">
          <span>${m.width || "?"}×${m.height || "?"}</span>
          <span>${m.nation_count || 0} nations</span>
          <span>${m.land_pct || "?"}% terre</span>
          <span>~${m.estimated_max_players || "?"} joueurs</span>
        </div>`;
      tooltipEl.style.display = "block";
      moveTooltip(e);
    });
    pin.addEventListener("mousemove", moveTooltip);
    pin.addEventListener("mouseleave", () => { if (tooltipEl) tooltipEl.style.display = "none"; });
    pin.addEventListener("click", () => showMapDetail(pin.dataset.slug));
  });

  function moveTooltip(e) {
    if (!tooltipEl) return;
    let x = e.clientX + 14, y = e.clientY - 10;
    if (x > window.innerWidth - 260) x = e.clientX - 240;
    tooltipEl.style.left = x + "px"; tooltipEl.style.top = y + "px";
  }

  ATLAS_VIEW.querySelectorAll(".atlas-card").forEach(card => {
    card.addEventListener("click", () => showMapDetail(card.dataset.slug));
  });

  // Pan & zoom de la carte du monde (molette / glisser / pincement / boutons)
  const mapWrap = ATLAS_VIEW.querySelector(".atlas-map-wrap");
  const mapSvg = ATLAS_VIEW.querySelector(".atlas-map-svg");
  if (mapWrap && mapSvg) initMapPanZoom(mapWrap, mapSvg, MAP_W, MAP_H);
}

function renderMapCard(m) {
  const name = m.translated_name || m.display_name || m.slug;
  const thumb = getThumbUrl(m.slug);
  const color = CAT_COLORS[m.category] || "#ff7a00";
  const catLabel = CATEGORIES.find(c => c.key === m.category)?.label || m.category;
  return `
    <div class="atlas-card" data-slug="${m.slug}">
      <div class="atlas-card-thumb">
        <img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.opacity=0">
        <span class="atlas-card-cat" style="--cat-color:${color}">${escapeHtml(catLabel)}</span>
      </div>
      <div class="atlas-card-body">
        <div class="atlas-card-name">${escapeHtml(name)}</div>
        <div class="atlas-card-meta">
          <span>${m.estimated_max_players || "?"} joueurs</span>
          <span>${m.nation_count || 0} nations</span>
          <span>${m.playlist_frequency || 0}× playlist</span>
        </div>
      </div>
    </div>`;
}

/* ═══ Page détail (reproduit openfront-atlas) ═══ */

function showMapDetail(slug) {
  const m = { slug, ...mapsData[slug] };
  if (!m.display_name) return;
  const name = m.translated_name || m.display_name;
  const mapImg = getMapUrl(slug);
  const color = CAT_COLORS[m.category] || "#ff7a00";
  const catLabel = CATEGORIES.find(c => c.key === m.category)?.label || m.category;
  const nations = m.nations || [];
  const aspectRatio = m.width && m.height ? `${m.width} / ${m.height}` : "3 / 2";

  const existing = document.getElementById("atlas-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "atlas-modal";
  modal.className = "atlas-modal-overlay";
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  modal.innerHTML = `
    <div class="atlas-detail">
      <button class="atlas-detail-close" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">&times;</button>
      <div class="atlas-detail-back" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">← Retour à l'Atlas</div>
      <div class="atlas-detail-grid">
        <div class="atlas-detail-map-wrap">
          <div class="atlas-detail-map-stage" style="aspect-ratio:${aspectRatio}">
            <img src="${escapeHtml(mapImg)}" alt="${escapeHtml(name)}" class="atlas-detail-map-img" onerror="this.src=${jsq(getThumbUrl(slug))}">
            ${nations.length > 0 ? `
            <div class="atlas-nation-overlay">
              ${nations.map(n => `
                <div class="atlas-nation-marker" style="left:${(n.x / m.width * 100).toFixed(1)}%;top:${(n.y / m.height * 100).toFixed(1)}%" title="${escapeHtml(n.name)}">
                  ${n.flag ? `<img src="${escapeHtml(getFlagUrl(n.flag))}" alt="" class="atlas-nation-flag" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''">` : ""}
                  <span class="atlas-nation-dot" ${n.flag ? 'style="display:none"' : ''}></span>
                  <span class="atlas-nation-label">${escapeHtml(n.name)}</span>
                </div>`).join("")}
            </div>` : ""}
          </div>
        </div>
        <div class="atlas-detail-info">
          <div class="atlas-detail-badges">
            <span class="atlas-detail-cat" style="--cat-color:${color}">${escapeHtml(catLabel)}</span>
            <span class="atlas-detail-freq">${m.playlist_frequency || 0}× playlist</span>
          </div>
          <h2 class="atlas-detail-name">${escapeHtml(name)}</h2>
          <div class="atlas-detail-stats">
            <div class="atlas-detail-stat"><span>${m.width || "?"} × ${m.height || "?"}</span><label>Dimensions</label></div>
            <div class="atlas-detail-stat"><span>${m.nation_count || 0}</span><label>Nations</label></div>
            <div class="atlas-detail-stat"><span>~${m.estimated_max_players || "?"}</span><label>Joueurs max</label></div>
            <div class="atlas-detail-stat"><span>${m.playlist_frequency || 0}×</span><label>Playlist</label></div>
          </div>
          <div class="atlas-detail-landbar">
            <div class="atlas-landbar-labels">
              <span style="color:#34d399">Terre ${m.land_pct ? m.land_pct.toFixed(1) : "?"}%</span>
              <span style="color:#38bdf8">Eau ${m.water_pct ? m.water_pct.toFixed(1) : "?"}%</span>
            </div>
            <div class="atlas-landbar-track">
              <div class="atlas-landbar-fill" style="width:${m.land_pct || 0}%"></div>
            </div>
          </div>
          <a class="atlas-detail-play" href="https://openfront.io/" target="_blank" rel="noopener">Jouer sur OpenFront →</a>
        </div>
      </div>
      ${nations.length > 0 ? `
      <div class="atlas-detail-nations">
        <h3>Nations <span class="atlas-detail-count">${nations.length}</span></h3>
        <div class="atlas-nations-grid">
          ${nations.map(n => `
            <div class="atlas-nation-card">
              <span class="atlas-nation-flag-wrap">
                ${n.flag ? `<img src="${escapeHtml(getFlagUrl(n.flag))}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
              </span>
              <span class="atlas-nation-card-name" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>
            </div>`).join("")}
        </div>
      </div>` : ""}
    </div>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";

  // Pan & zoom de la grande carte détail (molette / glisser / pincement / boutons)
  const stage = modal.querySelector(".atlas-detail-map-stage");
  if (stage) initDetailPanZoom(stage);

  const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

function closeModal() {
  const m = document.getElementById("atlas-modal");
  if (m) { m.remove(); document.body.style.overflow = ""; }
}

/* ════════════════════════════════════════════════════════════════════════
   Pan & zoom — « faire grossir la carte », scroll et déplacement
   Carte du monde (viewBox) + carte détail (transform). Zéro dépendance.
   ════════════════════════════════════════════════════════════════════════ */

const PZ_MIN = 1, PZ_MAX = 6;      // bornes de zoom (1× → 6×)
const PZ_STEP = 1.3;               // facteur des boutons / molette / double-clic

/** Point (clientX/clientY) → coordonnées internes du viewBox SVG courant. */
function svgClientPoint(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/** Boutons + / − / réinitialiser (coin haut-droit, au-dessus de la carte). */
function pzControls(wrap, handlers) {
  const box = document.createElement("div");
  box.className = "atlas-pz-controls";
  box.innerHTML = `
    <button type="button" class="atlas-pz-btn" data-act="in" aria-label="Zoomer sur la carte" title="Zoomer">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></svg>
    </button>
    <button type="button" class="atlas-pz-btn" data-act="out" aria-label="Dézoomer" title="Dézoomer">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>
    </button>
    <button type="button" class="atlas-pz-btn" data-act="reset" aria-label="Réinitialiser la vue de la carte" title="Réinitialiser la vue">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v6h-6"/></svg>
    </button>`;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".atlas-pz-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    handlers[btn.dataset.act]?.();
  });
  // Un double-clic sur les boutons ne doit pas aussi zoomer la carte
  box.addEventListener("dblclick", (e) => e.stopPropagation());
  wrap.appendChild(box);
  return box;
}

/** Facteur de zoom molette standardisé entre navigateurs (deltaY normalisé).
 *  Convention carte (Google Maps) : molette vers le haut (deltaY < 0) = zoom
 *  avant (facteur < 1), vers le bas = zoom arrière (facteur > 1). */
function wheelFactor(e) {
  const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
  if (d === 0) return 1;
  const f = Math.pow(1.0015, Math.max(-120, Math.min(120, d)) * 2);
  return Math.max(0.5, Math.min(2, f));
}

/**
 * Pan & zoom de la carte du monde (SVG). Manipule le viewBox (ratio 2:1
 * conservé → pas de déformation) :
 *   - molette          → zoom centré sur le curseur (desktop)
 *   - glisser souris   → déplacement (seuil 5 px, clic pas avalé sinon)
 *   - tactile zoomé    → 1 doigt déplace, 2 doigts pincent (touch-action:none)
 *   - tactile zoom 1×  → le doigt fait défiler la page (pas de scroll-trap)
 *   - double-clic      → zoom avant (hors pins)
 *   - boutons +/−/⟲    → accessibles partout
 */
function initMapPanZoom(wrap, svg, MAP_W, MAP_H) {
  if (!wrap || !svg || svg.dataset.pz === "1") return;
  svg.dataset.pz = "1";
  const RATIO = MAP_W / MAP_H;
  const vb = { x: 0, y: 0, w: MAP_W, h: MAP_H };

  const apply = () => {
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const zoomed = vb.w < MAP_W - 0.5;
    svg.classList.toggle("atlas-zoomed", zoomed);
  };
  const clamp = () => {
    vb.w = Math.min(MAP_W, Math.max(MAP_W / PZ_MAX, vb.w));
    vb.h = vb.w / RATIO;
    vb.x = Math.min(MAP_W - vb.w, Math.max(0, vb.x));
    vb.y = Math.min(MAP_H - vb.h, Math.max(0, vb.y));
  };
  const zoomAt = (px, py, factor) => {
    // facteur réel après clamp : la largeur cible reste dans [MAP_W/6, MAP_W]
    // → le ratio vb.w/MAP_W est borné à [1/PZ_MAX, 1] (PZ_MIN n'entre pas en
    // jeu ici : c'est un zoom-avant vers 1×, pas un dé-zoom sous la carte).
    const k = Math.min(1, Math.max(1 / PZ_MAX, (vb.w * factor) / MAP_W)) * (MAP_W / vb.w);
    if (k === 1 && vb.w === MAP_W) return;
    vb.x = px - (px - vb.x) * k;
    vb.y = py - (py - vb.y) * k;
    vb.w *= k;
    vb.h = vb.w / RATIO;
    clamp();
    apply();
  };
  const zoomCenter = (factor) => zoomAt(vb.x + vb.w / 2, vb.y + vb.h / 2, factor);
  const reset = () => { vb.x = 0; vb.y = 0; vb.w = MAP_W; vb.h = MAP_H; apply(); };

  pzControls(wrap, { in: () => zoomCenter(1 / PZ_STEP), out: () => zoomCenter(PZ_STEP), reset });

  // Molette = zoom (comportement carte, cf. Google Maps)
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = svgClientPoint(svg, e.clientX, e.clientY);
    zoomAt(p.x, p.y, wheelFactor(e));
  }, { passive: false });

  // Double-clic = zoom avant (sauf sur un pin : clic simple = détail)
  svg.addEventListener("dblclick", (e) => {
    if (e.target.closest && e.target.closest(".atlas-svg-pin")) return;
    e.preventDefault();
    const p = svgClientPoint(svg, e.clientX, e.clientY);
    zoomAt(p.x, p.y, 1 / PZ_STEP);
  });

  // ── Déplacement : souris (listeners fenêtre, cf. lobby.js) + tactile ──
  const DRAG_THRESHOLD = 5;
  const pointers = new Map();     // pointerId → {x, y} (tactile uniquement)
  let mouse = null;               // {sx, sy, vbX, vbY, moved}
  let pinch = null;               // {dist}
  let suppressClick = false;

  const pinchDist = () => {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      mouse = { sx: e.clientX, sy: e.clientY, vbX: vb.x, vbY: vb.y, moved: false };
      window.addEventListener("pointermove", mouseMove);
      window.addEventListener("pointerup", mouseUp);
      window.addEventListener("pointercancel", mouseUp);
      return;
    }
    // Tactile / stylet
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { pinch = { dist: pinchDist() }; mouse = null; }
    else pinch = null;
  });

  function panTo(clientX, clientY, from) {
    const rect = svg.getBoundingClientRect();
    const scale = vb.w / rect.width; // px viewBox par px écran
    vb.x = from.vbX - (clientX - from.sx) * scale;
    vb.y = from.vbY - (clientY - from.sy) * scale;
    clamp();
    apply();
  }

  function mouseMove(e) {
    if (!mouse) return;
    if (!mouse.moved) {
      if (Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) < DRAG_THRESHOLD) return;
      mouse.moved = true;
      suppressClick = true;
      svg.classList.add("atlas-dragging");
    }
    panTo(e.clientX, e.clientY, mouse);
  }
  function mouseUp() {
    window.removeEventListener("pointermove", mouseMove);
    window.removeEventListener("pointerup", mouseUp);
    window.removeEventListener("pointercancel", mouseUp);
    svg.classList.remove("atlas-dragging");
    mouse = null;
  }

  svg.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && pinch) {
      // Pincement : zoom autour du milieu des deux doigts
      const nd = pinchDist();
      const pts = [...pointers.values()];
      const mid = svgClientPoint(svg, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      zoomAt(mid.x, mid.y, pinch.dist / nd);
      pinch = { dist: nd };
    } else if (svg.classList.contains("atlas-zoomed") && pointers.size === 1) {
      // 1 doigt quand la carte est zoomée → déplacement (touch-action:none)
      const start = e._pzStart || { x: e.clientX, y: e.clientY, vbX: vb.x, vbY: vb.y };
      e._pzStart = start;
      panTo(e.clientX, e.clientY, start);
    }
  });

  const pointerEnd = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      p._start = null;
    }
  };
  svg.addEventListener("pointerup", pointerEnd);
  svg.addEventListener("pointercancel", pointerEnd);

  // Un vrai glisser avale le clic qui suit (sinon le clic ouvre le détail)
  svg.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

/**
 * Pan & zoom de la grande carte dans la modale détail (image + marqueurs
 * nations regroupés dans une couche transformée).
 */
function initDetailPanZoom(stage) {
  if (!stage || stage.dataset.pz === "1") return;
  stage.dataset.pz = "1";

  // Couche zoom : l'image + l'overlay des nations bougent ensemble
  const layer = document.createElement("div");
  layer.className = "atlas-detail-zoom";
  while (stage.firstChild) layer.appendChild(stage.firstChild);
  stage.appendChild(layer);

  let k = 1, tx = 0, ty = 0;
  const apply = () => {
    layer.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${k})`;
    stage.classList.toggle("atlas-zoomed", k > 1.001);
  };
  const clampPan = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    tx = Math.min(0, Math.max(w - w * k, tx));
    ty = Math.min(0, Math.max(h - h * k, ty));
  };
  const zoomAt = (cx, cy, factor) => {
    const k2 = Math.min(PZ_MAX, Math.max(PZ_MIN, k * factor));
    const real = k2 / k;
    if (real === 1) return;
    tx = cx - (cx - tx) * real;
    ty = cy - (cy - ty) * real;
    k = k2;
    clampPan();
    apply();
  };
  const zoomCenter = (factor) => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, factor);
  const reset = () => { k = 1; tx = 0; ty = 0; apply(); };

  // ⚠️ Ici le zoom est un FACTEUR D'ÉCHELLE (k : 1 → 6) : contrairement à la
  // carte du monde (viewBox), « zoomer » = multiplier k par PZ_STEP > 1.
  pzControls(stage, { in: () => zoomCenter(PZ_STEP), out: () => zoomCenter(1 / PZ_STEP), reset });

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, 1 / wheelFactor(e));
  }, { passive: false });

  stage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, PZ_STEP);
  });

  // Déplacement — mêmes règles que la carte du monde
  const DRAG_THRESHOLD = 5;
  const pointers = new Map();
  let mouse = null;
  let pinch = null;

  const pinchDist = () => {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  };
  const panTo = (clientX, clientY, from) => {
    tx = from.vbX + (clientX - from.sx);
    ty = from.vbY + (clientY - from.sy);
    clampPan();
    apply();
  };

  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      mouse = { sx: e.clientX, sy: e.clientY, vbX: tx, vbY: ty, moved: false };
      window.addEventListener("pointermove", mouseMove);
      window.addEventListener("pointerup", mouseUp);
      window.addEventListener("pointercancel", mouseUp);
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { pinch = { dist: pinchDist() }; mouse = null; }
    else pinch = null;
  });

  function mouseMove(e) {
    if (!mouse) return;
    if (!mouse.moved) {
      if (Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) < DRAG_THRESHOLD) return;
      mouse.moved = true;
      svgDraggingClass(stage, true);
    }
    panTo(e.clientX, e.clientY, mouse);
  }
  function mouseUp() {
    window.removeEventListener("pointermove", mouseMove);
    window.removeEventListener("pointerup", mouseUp);
    window.removeEventListener("pointercancel", mouseUp);
    svgDraggingClass(stage, false);
    mouse = null;
  }

  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && pinch) {
      const nd = pinchDist();
      const pts = [...pointers.values()];
      const r = stage.getBoundingClientRect();
      const cx = (pts[0].x + pts[1].x) / 2 - r.left;
      const cy = (pts[0].y + pts[1].y) / 2 - r.top;
      zoomAt(cx, cy, pinch.dist / nd);
      pinch = { dist: nd };
    } else if (stage.classList.contains("atlas-zoomed") && pointers.size === 1) {
      const start = e._pzStart || { x: e.clientX, y: e.clientY, vbX: tx, vbY: ty };
      e._pzStart = start;
      panTo(e.clientX, e.clientY, start);
    }
  });

  const pointerEnd = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  stage.addEventListener("pointerup", pointerEnd);
  stage.addEventListener("pointercancel", pointerEnd);

  // Reset automatique à la fermeture de la modale (nettoyage par recréation)
  apply();
}

function svgDraggingClass(el, on) { el.classList.toggle("atlas-dragging", on); }

loadAtlas();
