"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { VerifiedBadge } from "./VerifiedBadge";
import type { PlayerGame, PlayerProfile } from "@/lib/openfront/types";
import {
  baseName,
  formatDate,
  formatDuration,
  formatNumber,
  isVerifiedUsername,
} from "@/lib/openfront/format";

interface PlayerPayload {
  profile: PlayerProfile;
  profileFetchedAt: number;
  games: PlayerGame[];
  gamesFetchedAt: number;
}

function statSummary(profile: PlayerProfile) {
  const stats = profile.stats as {
    Ranked?: Record<string, { elo?: number; wins?: string; losses?: string; total?: string }>;
    recent?: { all?: { games?: number; wins?: number } };
    Public?: Record<string, { wins?: string; losses?: string; total?: string }>;
  };
  const ranked = stats.Ranked ?? {};
  const totalWins = Object.values(ranked).reduce(
    (sum, r) => sum + Number(r.wins ?? 0),
    0,
  );
  const totalLosses = Object.values(ranked).reduce(
    (sum, r) => sum + Number(r.losses ?? 0),
    0,
  );
  const recent = stats.recent?.all;
  const publicStats = stats.Public ?? {};
  const publicWins = Object.values(publicStats).reduce(
    (s, r) => s + Number(r.wins ?? 0),
    0,
  );
  return { totalWins, totalLosses, recent, publicWins };
}

export function PlayerModal({
  publicId,
  onClose,
}: {
  publicId: string | null;
  onClose: () => void;
}) {
  const query = useQuery<PlayerPayload>({
    queryKey: ["player", publicId],
    queryFn: async () => {
      const res = await fetch(`/api/openfront/player/${publicId}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "joueur introuvable");
      }
      return (await res.json()) as PlayerPayload;
    },
    enabled: publicId !== null,
    staleTime: 60_000,
  });

  const profile = query.data?.profile;
  const summary = profile ? statSummary(profile) : null;

  return (
    <Dialog open={publicId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl border-zinc-800 bg-zinc-950 text-zinc-100">
        {query.isPending && (
          <div className="flex flex-col gap-3">
            <DialogHeader>
              <DialogTitle>Chargement du joueur…</DialogTitle>
              <DialogDescription>
                Récupération du profil et des dernières parties.
              </DialogDescription>
            </DialogHeader>
            <Skeleton className="h-8 w-64 bg-zinc-900" />
            <Skeleton className="h-4 w-40 bg-zinc-900" />
            <Skeleton className="h-64 w-full bg-zinc-900" />
          </div>
        )}
        {query.isError && (
          <div className="p-4 text-center text-red-400">
            <DialogHeader>
              <DialogTitle className="sr-only">Erreur</DialogTitle>
            </DialogHeader>
            {(query.error as Error).message}
          </div>
        )}
        {query.data && profile && summary && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {isVerifiedUsername(profile.username) && <VerifiedBadge />}
                <span>{baseName(profile.username)}</span>
                {!isVerifiedUsername(profile.username) && (
                  <span className="text-sm font-normal text-zinc-500">
                    .{profile.username.split(".").slice(1).join(".")}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="text-zinc-500">
                Identifiant public : {profile.publicId} · compte créé le{" "}
                {formatDate(profile.createdAt)}
                {profile.clans && profile.clans.length > 0 && (
                  <> · clan {profile.clans[profile.clans.length - 1].tag}</>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-xs text-zinc-500">Victoires classées</p>
                <p className="text-xl font-bold text-emerald-400">
                  {formatNumber(summary.totalWins)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-xs text-zinc-500">Défaites classées</p>
                <p className="text-xl font-bold text-red-400">
                  {formatNumber(summary.totalLosses)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-xs text-zinc-500">Victoires publiques</p>
                <p className="text-xl font-bold text-teal-300">
                  {formatNumber(summary.publicWins)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-xs text-zinc-500">Parties récentes</p>
                <p className="text-xl font-bold text-zinc-100">
                  {formatNumber(summary.recent?.games ?? query.data.games.length)}
                  <span className="ml-1 text-sm font-normal text-zinc-500">
                    ({summary.recent?.wins ?? 0} vict.)
                  </span>
                </p>
              </div>
            </div>

            <ScrollArea className="max-h-80 rounded-lg border border-zinc-800">
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800">
                    <TableHead className="text-zinc-500">Date</TableHead>
                    <TableHead className="text-zinc-500">Carte</TableHead>
                    <TableHead className="text-right text-zinc-500">
                      Durée
                    </TableHead>
                    <TableHead className="text-right text-zinc-500">
                      Résultat
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.games.slice(0, 30).map((g) => (
                    <TableRow key={g.gameId} className="border-zinc-800">
                      <TableCell className="text-zinc-500">
                        {formatDate(g.start)}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-44 truncate text-zinc-200">
                          {g.map}
                        </span>
                        <span className="text-xs text-zinc-600">
                          {g.mode} · {g.totalPlayers} joueurs
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-zinc-300">
                        {formatDuration(g.durationSeconds)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={
                            g.result === "victory"
                              ? "border-emerald-500/40 text-emerald-400"
                              : "border-red-800 text-red-400"
                          }
                        >
                          {g.result === "victory" ? "Victoire" : "Défaite"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
