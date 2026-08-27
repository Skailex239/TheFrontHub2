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
  const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

function closeModal() {
  const m = document.getElementById("atlas-modal");
  if (m) { m.remove(); document.body.style.overflow = ""; }
}

loadAtlas();
