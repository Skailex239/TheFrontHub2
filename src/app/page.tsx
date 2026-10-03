"use client";

/**
 * Dashboard OpenFront — Top players all Time / Top players this Week.
 *
 * Architecture: le navigateur fait les requêtes API directement.
 *   - ranked.json (fichier statique) → career ranked wins top 100 1v1 + 2v2.
 *   - Firebase public-aliases (REST) → liste des joueurs connectés.
 *   - /api/openfront/public/player/<pid>/games (proxy Next.js avec
 *     x-skailex-access) → wins casual + hebdo pour les joueurs connectés.
 *
 * Le scoring (FFA casual +10, FFA ranked +1, Team casual +5, Team ranked +1)
 * est appliqué pour trier les classements.
 *
 * Layout: deux colonnes côte à côte (Top players all Time à gauche,
 * Top players this Week à droite), style "card blanche épurée" reproduit
 * de la maquette fournie par l'utilisateur.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trophy, Medal, BarChart3 } from "lucide-react";
import {
  buildMergedPlayers,
  fetchPlayerStats,
  fetchConnectedPlayers,
  fetchRankedJson,
  formatFrenchDate,
  formatPoints,
  getWeekStartMs,
  isCacheFresh,
  loadLiveCache,
  saveLiveCache,
  pointsFor,
  totalWins,
  type ConnectedPlayer,
  type LiveStats,
  type MergedPlayer,
  type RankedJson,
} from "@/lib/openfront";

/* ════════════════════════════════════════════════════════════════
   Constants
   ════════════════════════════════════════════════════════════════ */

const ORANGE = "#ff7a00";
const ORANGE_HOVER = "#e96e00";
const ORANGE_DEEP = "#c25700";
const ORANGE_PALE = "#fff4e9";
const ORANGE_PALE_BORDER = "rgba(255, 122, 0, 0.18)";

const TOP_N = 10;

/* ════════════════════════════════════════════════════════════════
   Component
   ════════════════════════════════════════════════════════════════ */

export default function DashboardPage() {
  // Week start (Europe/Paris, Monday 00:00) — computed once on mount.
  const [weekStartMs] = useState<number>(() => getWeekStartMs(Date.now()));

  // Data state
  const [rankedData, setRankedData] = useState<RankedJson | null>(null);
  const [connected, setConnected] = useState<ConnectedPlayer[]>([]);
  const [liveStats, setLiveStats] = useState<Record<string, LiveStats>>({});
  const [liveProgress, setLiveProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [liveDone, setLiveDone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Refs to avoid stale closures during parallel fetches.
  const liveStatsRef = useRef<Record<string, LiveStats>>({});
  const startedRef = useRef(false);

  /* ── Initial load: ranked.json + Firebase aliases + week info ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ranked, players] = await Promise.all([
        fetchRankedJson(),
        fetchConnectedPlayers(),
      ]);
      if (cancelled) return;
      setRankedData(ranked);
      setConnected(players);
      setLiveProgress({ done: 0, total: players.length });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Live fetch: paginate games for each connected player ── */
  useEffect(() => {
    if (startedRef.current) return;
    if (connected.length === 0) {
      setLiveDone(true);
      return;
    }
    startedRef.current = true;

    let cancelled = false;
    const cache = loadLiveCache();

    const fetchOne = async (player: ConnectedPlayer) => {
      const cachedEntry = cache[player.publicId];
      if (cachedEntry && isCacheFresh(cachedEntry)) {
        liveStatsRef.current[player.publicId] = cachedEntry;
        setLiveStats({ ...liveStatsRef.current });
        setLiveProgress((p) => ({ ...p, done: p.done + 1 }));
        return;
      }
      try {
        const entry = await fetchPlayerStats(player);
        if (cancelled) return;
        liveStatsRef.current[player.publicId] = entry;
        cache[player.publicId] = entry;
        saveLiveCache(cache);
        setLiveStats({ ...liveStatsRef.current });
      } catch (e) {
        console.warn(
          `[dashboard] live fetch failed for ${player.publicId}:`,
          (e as Error).message,
        );
      } finally {
        setLiveProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    };

    // Concurrent fetches (exemption = high concurrency allowed).
    Promise.all(connected.map(fetchOne)).then(() => {
      if (!cancelled) setLiveDone(true);
    });

    return () => {
      cancelled = true;
    };
  }, [connected, weekStartMs]);

  /* ── Merge ranked + live → two views ── */
  const { global: globalView, weekly: weeklyView } = useMemo(() => {
    return buildMergedPlayers(rankedData, liveStats);
  }, [rankedData, liveStats]);

  const isLoading = !rankedData && liveProgress.done < liveProgress.total;

  /* ════════════════════════════════════════════════════════════════
   Render
   ════════════════════════════════════════════════════════════════ */

  return (
    <div className="page-wrap" style={pageWrapStyle}>
      <main style={mainStyle}>
        <Header
          weekStartMs={weekStartMs}
          globalCount={globalView.length}
          weeklyCount={weeklyView.length}
          liveProgress={liveProgress}
          liveDone={liveDone}
        />

        {loadError && (
          <div style={errorBannerStyle}>
            ⚠️ {loadError}
          </div>
        )}

        {isLoading && globalView.length === 0 ? (
          <LoadingState />
        ) : (
          <div style={gridStyle} className="dash-grid">
            <RankingColumn
              title="Top players all Time"
              subtitle={`Classement cumulé · ${globalView.length} joueurs`}
              players={globalView}
              weekStartMs={weekStartMs}
              mode="global"
            />
            <RankingColumn
              title="Top players this Week"
              subtitle={`Depuis le ${formatFrenchDate(weekStartMs)} · ${weeklyView.length} joueurs actifs`}
              players={weeklyView}
              weekStartMs={weekStartMs}
              mode="weekly"
            />
          </div>
        )}

        <ScoringLegend />
      </main>

      <Footer />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   Sub-components
   ════════════════════════════════════════════════════════════════ */

function Header({
  weekStartMs,
  globalCount,
  weeklyCount,
  liveProgress,
  liveDone,
}: {
  weekStartMs: number;
  globalCount: number;
  weeklyCount: number;
  liveProgress: { done: number; total: number };
  liveDone: boolean;
}) {
  const pct = liveProgress.total > 0
    ? Math.min(100, Math.round((liveProgress.done / liveProgress.total) * 100))
    : 0;
  return (
    <header style={headerStyle}>
      <div style={headerTopStyle}>
        <span style={logoBadgeStyle} aria-hidden="true">
          <Trophy size={36} color={ORANGE_DEEP} strokeWidth={2.5} />
        </span>
        <div>
          <h1 style={h1Style}>OpenFront · Tableau de bord</h1>
          <p style={subtitleStyle}>
            Classement des meilleurs joueurs ·{" "}
            <strong style={{ color: ORANGE_DEEP }}>
              Cette semaine a commencé le {formatFrenchDate(weekStartMs)}
            </strong>
          </p>
        </div>
      </div>
      <div style={headerMetaStyle}>
        {liveProgress.total > 0 && !liveDone && (
          <div style={progressBarStyle} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Chargement des stats live">
            <div style={progressHeaderStyle}>
              <span style={progressLabelStyle}>
                <BarChart3 size={14} color={ORANGE} strokeWidth={2.5} />
                Chargement des stats live…
              </span>
              <span style={progressPctStyle}>{pct}%</span>
            </div>
            <div style={progressTrackStyle}>
              <div style={{ ...progressFillStyle, width: `${pct}%` }} />
            </div>
          </div>
        )}
        <span style={metaTextStyle}>
          {globalCount} joueurs au classement global · {weeklyCount} actifs cette semaine
        </span>
      </div>
    </header>
  );
}

function LoadingState() {
  return (
    <div style={loadingStateStyle}>
      <div className="spinner" style={spinnerStyle} />
      <h3 style={{ margin: 0, color: "#111827", fontSize: 18 }}>
        Chargement du classement…
      </h3>
      <p style={{ margin: 0, color: "#6B7280", fontSize: 14 }}>
        Récupération des données via l'API OpenFront…
      </p>
    </div>
  );
}

function RankingColumn({
  title,
  subtitle,
  players,
  weekStartMs,
  mode,
}: {
  title: string;
  subtitle: string;
  players: MergedPlayer[];
  weekStartMs: number;
  mode: "global" | "weekly";
}) {
  const topN = players.slice(0, TOP_N);
  const hasData = topN.length > 0;

  return (
    <section style={columnStyle} className="dash-section">
      <div style={columnHeaderStyle}>
        <h2 style={columnTitleStyle}>{title}</h2>
        <span style={columnSubtitleStyle}>{subtitle}</span>
      </div>

      {hasData ? (
        <div style={listStyle} className="dash-list">
          {topN.map((player, idx) => (
            <RankingRow key={player.publicId} player={player} rank={idx + 1} mode={mode} />
          ))}
        </div>
      ) : (
        <div style={emptyListStyle}>
          <p style={{ margin: 0, color: "#6B7280", fontSize: 14 }}>
            {mode === "weekly"
              ? "Aucune partie cette semaine pour le moment."
              : "Aucune donnée disponible."}
          </p>
        </div>
      )}

      <button
        type="button"
        style={moreBtnStyle}
        className="dash-more-btn"
        onClick={() => {
          // Future: open full ranking modal. For now, no-op.
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = ORANGE_HOVER;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = ORANGE;
        }}
      >
        Voir plus de joueurs
      </button>

      <div style={columnFooterStyle} aria-hidden="true">
        {/* week info for screen readers */}
        <span className="sr-only">
          Semaine du {formatFrenchDate(weekStartMs)}.
        </span>
      </div>
    </section>
  );
}

function RankingRow({
  player,
  rank,
  mode,
}: {
  player: MergedPlayer;
  rank: number;
  mode: "global" | "weekly";
}) {
  const points = pointsFor(player);
  const wins = totalWins(player);
  const ffaWins = (player.ffaCasualWins || 0) + (player.ffaRankedWins || 0);
  const teamWins = (player.teamCasualWins || 0) + (player.teamRankedWins || 0);

  return (
    <a
      href={`/profile.html?pid=${encodeURIComponent(player.publicId)}&player=${encodeURIComponent(player.username)}`}
      style={rowStyle}
      className="dash-row"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = ORANGE_PALE;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <RankBadge rank={rank} />

      <div style={playerInfoStyle} className="dash-player">
        <span style={playerNameStyle} className="dash-player-name">
          {player.username}
          {player.clan && (
            <span style={clanTagStyle}> [{player.clan}]</span>
          )}
        </span>
        <span style={playerSubStyle} className="dash-player-sub">
          {wins} wins · FFA {ffaWins} · Team {teamWins}
          {mode === "weekly" && player.hasLive && (
            <span style={{ color: ORANGE_DEEP, marginLeft: 6 }}>· cette semaine</span>
          )}
        </span>
      </div>

      <div style={scoreWrapStyle} className="dash-score">
        <span style={scoreValStyle} className="dash-score-val">
          {formatPoints(points)}
        </span>
        <span style={scoreSuffixStyle} className="dash-score-suffix">
          pts
        </span>
      </div>
    </a>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span style={{ ...trophyStyle, color: "#D4A017" }} aria-label="Rang 1">
        <Trophy size={22} strokeWidth={2.5} />
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span style={{ ...trophyStyle, color: "#9CA3AF" }} aria-label="Rang 2">
        <Medal size={22} strokeWidth={2.5} />
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span style={{ ...trophyStyle, color: "#B45309" }} aria-label="Rang 3">
        <Medal size={22} strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span style={rankBadgeStyle} className="dash-rank-badge" aria-label={`Rang ${rank}`}>
      {rank}
    </span>
  );
}

function ScoringLegend() {
  return (
    <div style={legendStyle} className="dash-legend">
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <span>
        Barème : <strong>FFA casual +10</strong> · <strong>FFA classé +1</strong> ·{" "}
        <strong>Team casual +5</strong> · <strong>Team classé +1</strong>{" "}
        (le classé rapporte juste 1 pt, pas en plus du FFA/Team). Les classements
        sont calculés en direct depuis l'API OpenFront (header{" "}
        <code style={codeStyle}>x-skailex-access</code> côté serveur pour
        l'exemption de rate-limit).
      </span>
    </div>
  );
}

function Footer() {
  return (
    <footer style={footerStyle} className="dash-footer">
      <div style={footerInnerStyle}>
        <span>
          Données fournies par l'API publique OpenFront · Mises à jour en direct
          dans le navigateur (cache 30 min).
        </span>
        <span style={{ color: "#9CA3AF" }}>
          TheFrontHub · {new Date().getFullYear()}
        </span>
      </div>
    </footer>
  );
}

/* ════════════════════════════════════════════════════════════════
   Inline styles (kept here for self-containment; responsive via CSS
   injected below).
   ════════════════════════════════════════════════════════════════ */

const pageWrapStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  background: "#FAFAFA",
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  maxWidth: 1200,
  margin: "0 auto",
  padding: "32px 24px 48px",
  fontFamily:
    "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#111827",
  fontVariantNumeric: "tabular-nums",
};

const headerStyle: React.CSSProperties = {
  marginBottom: 28,
};

const headerTopStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  marginBottom: 12,
};

const logoBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 52,
  height: 52,
  borderRadius: 14,
  background: ORANGE_PALE,
  border: `1px solid ${ORANGE_PALE_BORDER}`,
  flexShrink: 0,
};

const h1Style: React.CSSProperties = {
  margin: 0,
  fontSize: 28,
  fontWeight: 800,
  letterSpacing: "-0.02em",
  color: "#111827",
};

const subtitleStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 14,
  color: "#6B7280",
};

const headerMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 8,
};

const progressBarStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 12px",
  background: ORANGE_PALE,
  border: `1px solid ${ORANGE_PALE_BORDER}`,
  borderRadius: 10,
  minWidth: 240,
};
const progressHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const progressLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: ORANGE_DEEP,
  fontSize: 12,
  fontWeight: 600,
};
const progressPctStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: ORANGE_DEEP,
  fontVariantNumeric: "tabular-nums",
};
const progressTrackStyle: React.CSSProperties = {
  height: 5,
  background: "rgba(249, 115, 22, 0.15)",
  borderRadius: 999,
  overflow: "hidden",
};
const progressFillStyle: React.CSSProperties = {
  height: "100%",
  background: `linear-gradient(90deg, ${ORANGE}, ${ORANGE_DEEP})`,
  borderRadius: 999,
  transition: "width 0.4s ease",
};

const liveTagDoneStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "6px 12px",
  background: "rgba(34, 197, 94, 0.12)",
  border: "1px solid rgba(34, 197, 94, 0.25)",
  borderRadius: 999,
  color: "#16a34a",
  fontSize: 12,
  fontWeight: 600,
};

const metaTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#9CA3AF",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 24,
  alignItems: "start",
};

const columnStyle: React.CSSProperties = {
  background: "#FFFFFF",
  border: "1px solid #F3F4F6",
  borderRadius: 16,
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.03)",
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const columnHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  paddingBottom: 12,
  borderBottom: "1px solid #F3F4F6",
};

const columnTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 700,
  color: "#111827",
  letterSpacing: "-0.01em",
};

const columnSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#6B7280",
};

const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: 580,
  overflowY: "auto",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const emptyListStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 200,
  padding: 24,
  textAlign: "center",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "12px 4px",
  borderBottom: "1px solid #F3F4F6",
  textDecoration: "none",
  color: "inherit",
  transition: "background 0.15s ease",
  cursor: "pointer",
};

const trophyStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  flexShrink: 0,
};

const rankBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 8,
  background: ORANGE,
  color: "#FFFFFF",
  fontSize: 13,
  fontWeight: 700,
  flexShrink: 0,
  fontFamily: "var(--font-geist-mono), monospace",
};

const playerInfoStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const playerNameStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: ORANGE_DEEP,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  textDecoration: "none",
};

const clanTagStyle: React.CSSProperties = {
  color: "#9CA3AF",
  fontWeight: 500,
  fontSize: 13,
};

const playerSubStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#9CA3AF",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const scoreWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 4,
  flexShrink: 0,
  minWidth: 90,
  justifyContent: "flex-end",
};

const scoreValStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: "#111827",
  fontFamily: "var(--font-geist-mono), monospace",
};

const scoreSuffixStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6B7280",
  fontWeight: 500,
};

const moreBtnStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 24px",
  background: ORANGE,
  color: "#FFFFFF",
  border: "none",
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "background 0.18s ease",
  boxShadow: "0 2px 4px rgba(255, 122, 0, 0.2)",
  marginTop: 8,
};

const columnFooterStyle: React.CSSProperties = {
  display: "none",
};

const legendStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  marginTop: 24,
  padding: "14px 16px",
  background: ORANGE_PALE,
  border: `1px solid ${ORANGE_PALE_BORDER}`,
  borderRadius: 12,
  fontSize: 13,
  color: "#6B7280",
  lineHeight: 1.5,
};

const codeStyle: React.CSSProperties = {
  padding: "1px 6px",
  background: "rgba(255, 122, 0, 0.1)",
  borderRadius: 4,
  fontFamily: "var(--font-geist-mono), monospace",
  fontSize: 12,
  color: ORANGE_DEEP,
};

const footerStyle: React.CSSProperties = {
  marginTop: "auto",
  borderTop: "1px solid #F3F4F6",
  background: "#FFFFFF",
};

const footerInnerStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "16px 24px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  fontSize: 12,
  color: "#6B7280",
};

const loadingStateStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  minHeight: 320,
  textAlign: "center",
};

const spinnerStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: "3px solid #F3F4F6",
  borderTopColor: ORANGE,
  borderRadius: "50%",
  animation: "dash-spin 0.8s linear infinite",
};

const errorBannerStyle: React.CSSProperties = {
  marginBottom: 16,
  padding: "12px 16px",
  background: "rgba(239, 68, 68, 0.08)",
  border: "1px solid rgba(239, 68, 68, 0.25)",
  borderRadius: 10,
  color: "#b91c1c",
  fontSize: 14,
};
