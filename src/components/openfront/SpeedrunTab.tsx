"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DashboardPayload } from "@/lib/openfront/types";
import { formatDate, formatDuration, formatNumber, relativeTime } from "@/lib/openfront/format";

type Speedrun = NonNullable<DashboardPayload["speedrun"]>;

export function SpeedrunTab({
  speedrun,
  onSelectPlayer,
}: {
  speedrun: Speedrun | null;
  onSelectPlayer: (publicId: string) => void;
}) {
  const [view, setView] = useState<"top" | "maps">("top");
  const [mapFilter, setMapFilter] = useState<string>("all");

  const maps = useMemo(() => {
    const set = new Set((speedrun?.top ?? []).map((r) => r.map));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [speedrun]);

  const rows = useMemo(() => {
    if (!speedrun) return [];
    const list = [...speedrun.top].sort(
      (a, b) =>
        a.durationSeconds - b.durationSeconds || a.gameId.localeCompare(b.gameId),
    );
    if (mapFilter === "all") return list;
    return list.filter((r) => r.map === mapFilter);
  }, [speedrun, mapFilter]);

  if (!speedrun) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center">
        <p className="text-zinc-400">
          Calcul des records de vitesse en cours…
        </p>
        <p className="mt-1 text-sm text-zinc-600">
          Le service analyse l&apos;historique des 40 meilleurs joueurs classés
          (une passe toutes les 10 minutes). Revenez dans un instant.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">
            Speedrun — victoires les plus rapides
          </h3>
          <p className="text-sm text-zinc-500">
            {speedrun.playerCount} joueurs analysés ·{" "}
            {formatNumber(speedrun.top.length)} victoires classées · calcul{" "}
            {relativeTime(speedrun.computedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={view} onValueChange={(v) => setView(v as "top" | "maps")}>
            <TabsList className="bg-zinc-900 border border-zinc-800">
              <TabsTrigger
                value="top"
                className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300"
              >
                Classement
              </TabsTrigger>
              <TabsTrigger
                value="maps"
                className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300"
              >
                Records par carte
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {view === "top" && (
            <Select value={mapFilter} onValueChange={setMapFilter}>
              <SelectTrigger className="w-44 bg-zinc-900 border-zinc-800 text-zinc-200">
                <SelectValue placeholder="Toutes les cartes" />
              </SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-800">
                <SelectItem value="all">Toutes les cartes</SelectItem>
                {maps.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {view === "top" ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="w-12 text-zinc-500">#</TableHead>
                <TableHead className="text-zinc-500">Joueur</TableHead>
                <TableHead className="text-zinc-500">Carte</TableHead>
                <TableHead className="text-right text-zinc-500">Durée</TableHead>
                <TableHead className="hidden text-right text-zinc-500 sm:table-cell">
                  Joueurs
                </TableHead>
                <TableHead className="hidden text-right text-zinc-500 md:table-cell">
                  Date
                </TableHead>
                <TableHead className="text-right text-zinc-500" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 60).map((r, i) => (
                <TableRow
                  key={r.gameId}
                  className="cursor-pointer hover:bg-zinc-900"
                  onClick={() => onSelectPlayer(r.publicId)}
                >
                  <TableCell className="text-zinc-500">{i + 1}</TableCell>
                  <TableCell className="max-w-40 truncate font-medium text-zinc-100">
                    {r.username}
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-zinc-300">
                    {r.map}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold text-emerald-400">
                    {formatDuration(r.durationSeconds)}
                  </TableCell>
                  <TableCell className="hidden text-right text-zinc-400 sm:table-cell">
                    {r.totalPlayers}
                  </TableCell>
                  <TableCell className="hidden text-right text-zinc-500 md:table-cell">
                    {formatDate(r.start)}
                  </TableCell>
                  <TableCell className="text-right">
                    <a
                      href={`https://openfront.io/game/${r.gameId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal-400 hover:text-emerald-300"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Partie
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <p className="p-6 text-center text-zinc-500">
              Aucune victoire pour ce filtre.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {speedrun.byMap.map((m) => (
            <div
              key={m.map}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium text-zinc-100">{m.map}</p>
                <Badge variant="outline" className="border-zinc-700 text-zinc-400">
                  {m.count} vict.
                </Badge>
              </div>
              <p className="mt-2 font-mono text-xl font-bold text-emerald-400">
                {formatDuration(m.record.durationSeconds)}
              </p>
              <button
                className="mt-1 text-sm text-zinc-400 hover:text-emerald-300"
                onClick={() => onSelectPlayer(m.record.publicId)}
              >
                {m.record.username} · {formatDate(m.record.start)}
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-zinc-600">
        Méthodologie : les victoires les plus courtes des 100 dernières parties
        des meilleurs joueurs classés et des joueurs suivis. Chaque entrée est
        identifiée par son identifiant de partie : la liste est stable entre
        deux rafraîchissements, les pseudos proviennent du registre.
      </p>
    </div>
  );
}
