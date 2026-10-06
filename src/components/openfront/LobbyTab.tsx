"use client";

// Onglet Lobbies — épuré : une simple ligne d'état puis la liste des parties.
// (Les cartes de statistiques — parties analysées, stats des cartes, joueurs
// en file — ont été retirées à la demande de l'utilisateur.)
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { LobbyInfo, LobbySnapshot } from "@/lib/openfront/types";
import {
  GAME_TYPE_LABELS,
  formatCountdown,
  relativeTime,
} from "@/lib/openfront/format";

function LobbyCard({
  lobby,
  now,
  serverTime,
}: {
  lobby: LobbyInfo;
  now: number;
  serverTime: number;
}) {
  const [copied, setCopied] = useState(false);
  const offset = serverTime > 0 ? serverTime - now : 0;
  const startsIn = lobby.startsAt ? lobby.startsAt - (now + offset) : null;
  const filled =
    lobby.gameConfig?.maxPlayers && lobby.gameConfig.maxPlayers > 0
      ? Math.min(100, (lobby.numClients / lobby.gameConfig.maxPlayers) * 100)
      : 0;

  const typeLabel =
    GAME_TYPE_LABELS[lobby.publicGameType] ?? lobby.publicGameType;
  const typeColor =
    lobby.publicGameType === "ffa"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
      : lobby.publicGameType === "team"
        ? "bg-teal-500/15 text-teal-300 border-teal-500/30"
        : lobby.publicGameType === "hosted"
          ? "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30"
          : "bg-amber-500/15 text-amber-300 border-amber-500/30";

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur transition-colors hover:border-emerald-500/40">
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-zinc-100 truncate">
              {lobby.gameConfig?.gameMap ?? "Carte inconnue"}
            </p>
            <p className="text-xs text-zinc-500 truncate">
              {typeLabel}
              {lobby.gameConfig?.gameMode ? ` · ${lobby.gameConfig.gameMode}` : ""}
              {lobby.gameConfig?.difficulty ? ` · ${lobby.gameConfig.difficulty}` : ""}
            </p>
          </div>
          <Badge variant="outline" className={`shrink-0 ${typeColor}`}>
            {lobby.numClients}/{lobby.gameConfig?.maxPlayers ?? "?"}
          </Badge>
        </div>

        <Progress
          value={filled}
          className="h-1.5 bg-zinc-800 [&>div]:bg-emerald-500"
        />

        <div className="flex items-center justify-between gap-2">
          {startsIn !== null ? (
            <span
              className={`text-xs font-medium ${
                startsIn <= 30_000 ? "text-amber-400" : "text-emerald-400"
              }`}
            >
              Départ dans {formatCountdown(startsIn)}
            </span>
          ) : (
            <span className="text-xs text-zinc-500">
              {lobby.custom ? "Partie personnalisée" : "En attente de joueurs"}
            </span>
          )}
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs border-zinc-700 hover:border-emerald-500/50 hover:text-emerald-300"
              onClick={() => {
                void navigator.clipboard?.writeText(lobby.gameID);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title="Copier l'identifiant de partie"
            >
              {copied ? "Copié !" : "ID"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs border-zinc-700 hover:border-emerald-500/50 hover:text-emerald-300"
              asChild
            >
              <a
                href={`https://openfront.io/game/${lobby.gameID}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Rejoindre
              </a>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function LobbyTab({
  snapshot,
  viaWorker,
}: {
  snapshot: LobbySnapshot;
  viaWorker?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const groups: Array<[string, LobbyInfo[]]> = [
    ["ffa", snapshot.games.filter((g) => g.publicGameType === "ffa")],
    ["team", snapshot.games.filter((g) => g.publicGameType === "team")],
    ["special", snapshot.games.filter((g) => g.publicGameType === "special")],
    ["hosted", snapshot.games.filter((g) => g.publicGameType === "hosted")],
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Ligne d'état unique (remplace les quatre cartes de stats) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              snapshot.connected ? "bg-emerald-400 animate-pulse" : "bg-red-500"
            }`}
          />
          <span className="text-zinc-400">
            {snapshot.connected ? "Flux temps réel connecté" : "Reconnexion…"}
          </span>
        </span>
        {snapshot.serverHost && (
          <span className="truncate">· {snapshot.serverHost}</span>
        )}
        <span>
          · actualisé{" "}
          {relativeTime(snapshot.lastFrameAt || snapshot.generatedAt || 0, now)}
        </span>
        {viaWorker && (
          <Badge
            variant="outline"
            className="border-fuchsia-500/40 text-fuchsia-300"
            title="Les lobbies proviennent de ton worker Cloudflare"
          >
            worker
          </Badge>
        )}
        {snapshot.lastError && !snapshot.connected && (
          <span
            className="truncate text-amber-500"
            title={snapshot.lastError}
          >
            · {snapshot.lastError}
          </span>
        )}
      </div>

      {/* Lobbies par catégorie */}
      {groups.map(([type, games]) =>
        games.length > 0 ? (
          <section key={type} aria-label={GAME_TYPE_LABELS[type] ?? type}>
            <div className="mb-3 flex items-center gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
                {GAME_TYPE_LABELS[type] ?? type}
              </h3>
              <Badge variant="outline" className="border-zinc-700 text-zinc-400">
                {games.length}
              </Badge>
              <div className="h-px flex-1 bg-zinc-800" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {games.map((lobby) => (
                <LobbyCard
                  key={lobby.gameID}
                  lobby={lobby}
                  now={now}
                  serverTime={snapshot.serverTime}
                />
              ))}
            </div>
          </section>
        ) : null,
      )}

      {snapshot.games.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center text-zinc-500">
          {snapshot.connected
            ? "Aucun lobby public pour le moment — la liste se remplira dès qu'une partie est créée."
            : "Connexion au flux des lobbies en cours…"}
        </div>
      )}
    </div>
  );
}
