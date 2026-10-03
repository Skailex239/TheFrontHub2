"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VerifiedBadge } from "./VerifiedBadge";
import type { LeaderboardData, LeaderboardEntry, RegistryPlayer } from "@/lib/openfront/types";
import { baseName, formatNumber, isVerifiedUsername } from "@/lib/openfront/format";

function BoardRow({
  entry,
  renamed,
  prevUsernames,
  onSelect,
}: {
  entry: LeaderboardEntry;
  renamed?: boolean;
  prevUsernames?: string[];
  onSelect: (publicId: string) => void;
}) {
  const winrate =
    entry.total > 0 ? Math.round((entry.wins / entry.total) * 100) : 0;
  return (
    <TableRow
      className="cursor-pointer hover:bg-zinc-900"
      onClick={() => onSelect(entry.public_id)}
    >
      <TableCell className="w-12 text-zinc-500">{entry.rank}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5 min-w-0">
          {isVerifiedUsername(entry.username) && <VerifiedBadge />}
          <span className="truncate font-medium text-zinc-100">
            {baseName(entry.username)}
          </span>
          {!isVerifiedUsername(entry.username) && (
            <span className="text-zinc-600">.{entry.username.split(".").slice(1).join(".")}</span>
          )}
          {renamed && (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/40 text-amber-400"
              title={`Anciens pseudos : ${(prevUsernames ?? []).join(", ")}`}
            >
              renommé
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono font-semibold text-emerald-400">
        {formatNumber(entry.elo)}
      </TableCell>
      <TableCell className="hidden text-right text-zinc-500 sm:table-cell">
        {formatNumber(entry.peakElo)}
      </TableCell>
      <TableCell className="hidden text-right text-zinc-400 md:table-cell">
        <span className="text-emerald-500">{formatNumber(entry.wins)}</span>
        <span className="text-zinc-600"> / </span>
        <span className="text-red-400">{formatNumber(entry.losses)}</span>
      </TableCell>
      <TableCell className="hidden text-right md:table-cell">
        <Badge
          variant="outline"
          className={
            winrate >= 55
              ? "border-emerald-500/40 text-emerald-400"
              : winrate >= 45
                ? "border-teal-500/40 text-teal-300"
                : "border-zinc-700 text-zinc-400"
          }
        >
          {winrate} %
        </Badge>
      </TableCell>
    </TableRow>
  );
}

export function LeaderboardTab({
  leaderboard,
  registry,
  onSelectPlayer,
}: {
  leaderboard: LeaderboardData;
  registry: RegistryPlayer[];
  onSelectPlayer: (publicId: string) => void;
}) {
  const [board, setBoard] = useState<"1v1" | "2v2">("1v1");
  const [query, setQuery] = useState("");

  // Registre : pseudo stable + badge « renommé » plutôt qu'un changement muet.
  const renamedBy = useMemo(() => {
    const map = new Map<string, { renamed: boolean; prev: string[] }>();
    for (const p of registry) {
      map.set(p.publicId, {
        renamed: !!p.renamedRecently,
        prev: p.prevUsernames,
      });
    }
    return map;
  }, [registry]);

  const rows = useMemo(() => {
    const list = leaderboard[board] ?? [];
    const q = query.trim().toLowerCase();
    // Tri stable par rang : l'ordre ne « saute » pas entre deux rafraîchissements.
    const sorted = [...list].sort((a, b) => a.rank - b.rank);
    if (!q) return sorted;
    return sorted.filter((e) => e.username.toLowerCase().includes(q));
  }, [leaderboard, board, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={board} onValueChange={(v) => setBoard(v as "1v1" | "2v2")}>
          <TabsList className="bg-zinc-900 border border-zinc-800">
            <TabsTrigger value="1v1" className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300">
              Classement 1v1
            </TabsTrigger>
            <TabsTrigger value="2v2" className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300">
              Classement 2v2
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer par pseudo…"
          className="sm:max-w-xs bg-zinc-900 border-zinc-800"
        />
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="w-12 text-zinc-500">#</TableHead>
              <TableHead className="text-zinc-500">Joueur</TableHead>
              <TableHead className="text-right text-zinc-500">Elo</TableHead>
              <TableHead className="hidden text-right text-zinc-500 sm:table-cell">Elo max</TableHead>
              <TableHead className="hidden text-right text-zinc-500 md:table-cell">V / D</TableHead>
              <TableHead className="hidden text-right text-zinc-500 md:table-cell">Taux</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => {
              const info = renamedBy.get(entry.public_id);
              return (
                <BoardRow
                  key={entry.public_id}
                  entry={entry}
                  renamed={info?.renamed}
                  prevUsernames={info?.prev}
                  onSelect={onSelectPlayer}
                />
              );
            })}
          </TableBody>
        </Table>
        {rows.length === 0 && (
          <p className="p-6 text-center text-zinc-500">Aucun joueur trouvé.</p>
        )}
      </div>
      <p className="text-xs text-zinc-600">
        Cliquez sur un joueur pour voir son profil et ses dernières parties. Tri
        stable par rang — l&apos;ordre ne change pas au rafraîchissement.
      </p>
    </div>
  );
}
