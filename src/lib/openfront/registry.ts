// Registre des joueurs : pseudo stable + détection de renommage.
//
// À chaque rafraîchissement du classement on upserte les joueurs vus.
// Si le pseudo d'un publicId change, l'ancien est archivé dans prevUsernames
// et le front affiche un badge « renommé » — au lieu de changer le pseudo
// silencieusement entre deux rafraîchissements.
import "server-only";
import { db } from "@/lib/db";
import type { LeaderboardEntry, RegistryPlayer } from "./types";
import { getLeaderboard } from "./client";

const RENAME_RECENT_MS = 60 * 60 * 1000; // 1 h

export async function syncRegistryFromLeaderboard(): Promise<void> {
  const { data } = await getLeaderboard();
  if (!data) return;
  const entries: LeaderboardEntry[] = [...(data["1v1"] ?? []), ...(data["2v2"] ?? [])];
  if (entries.length === 0) return;

  const now = new Date();
  // Upsert par lots pour rester rapide.
  for (let i = 0; i < entries.length; i += 25) {
    const batch = entries.slice(i, i + 25);
    await Promise.all(
      batch.map(async (e) => {
        try {
          const existing = await db.player.findUnique({
            where: { publicId: e.public_id },
          });
          const prev = Array.isArray(existing?.prevUsernames)
            ? ((existing?.prevUsernames as unknown[]) ?? []).filter(
                (u): u is string => typeof u === "string",
              )
            : [];
          if (existing && existing.username !== e.username) {
            // Renommage détecté : on archive l'ancien pseudo (sans doublon).
            const nextPrev = prev.includes(existing.username)
              ? prev
              : [...prev, existing.username].slice(-10);
            await db.player.update({
              where: { publicId: e.public_id },
              data: {
                username: e.username,
                prevUsernames: nextPrev,
                lastSeenAt: now,
                lastRenamedAt: now,
                elo: e.elo,
                wins: e.wins,
                losses: e.losses,
              },
            });
          } else {
            await db.player.upsert({
              where: { publicId: e.public_id },
              create: {
                publicId: e.public_id,
                username: e.username,
                source: "leaderboard",
                firstSeenAt: now,
                lastSeenAt: now,
                elo: e.elo,
                wins: e.wins,
                losses: e.losses,
              },
              update: {
                username: e.username,
                lastSeenAt: now,
                elo: e.elo,
                wins: e.wins,
                losses: e.losses,
              },
            });
          }
        } catch (err) {
          console.warn(
            `[registry] upsert ${e.public_id} échoué:`,
            (err as Error).message,
          );
        }
      }),
    );
  }
}

export async function listRegistry(limit = 500): Promise<RegistryPlayer[]> {
  const rows = await db.player.findMany({
    orderBy: [{ tracked: "desc" }, { elo: "desc" }],
    take: limit,
  });
  return rows.map((r) => ({
    publicId: r.publicId,
    username: r.username,
    prevUsernames: Array.isArray(r.prevUsernames)
      ? ((r.prevUsernames as unknown[]) ?? []).filter(
          (u): u is string => typeof u === "string",
        )
      : [],
    tracked: r.tracked,
    elo: r.elo,
    wins: r.wins,
    losses: r.losses,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    renamedRecently: r.lastRenamedAt
      ? Date.now() - r.lastRenamedAt.getTime() < RENAME_RECENT_MS
      : false,
  }));
}

export async function searchPlayers(query: string): Promise<RegistryPlayer[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await db.player.findMany({
    where: {
      OR: [{ username: { contains: q } }, { publicId: { contains: q } }],
    },
    orderBy: [{ tracked: "desc" }, { elo: "desc" }],
    take: 25,
  });
  return rows.map((r) => ({
    publicId: r.publicId,
    username: r.username,
    prevUsernames: Array.isArray(r.prevUsernames)
      ? ((r.prevUsernames as unknown[]) ?? []).filter(
          (u): u is string => typeof u === "string",
        )
      : [],
    tracked: r.tracked,
    elo: r.elo,
    wins: r.wins,
    losses: r.losses,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    renamedRecently: r.lastRenamedAt
      ? Date.now() - r.lastRenamedAt.getTime() < RENAME_RECENT_MS
      : false,
  }));
}

export async function setTracked(publicId: string, tracked: boolean) {
  const now = new Date();
  const existing = await db.player.findUnique({ where: { publicId } });
  if (existing) {
    await db.player.update({ where: { publicId }, data: { tracked } });
    return { ok: true, username: existing.username };
  }
  // Joueur inconnu : on l'insère avec un pseudo par défaut, il sera
  // corrigé au prochain rafraîchissement.
  await db.player.create({
    data: {
      publicId,
      username: publicId,
      tracked,
      source: "manual",
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  return { ok: true, username: publicId };
}
