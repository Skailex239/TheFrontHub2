import { PublicLobbyMessageSchema } from "../openfront-src/src/core/Schemas";
import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("/home/z/my-project/data/lobby_frames.json", "utf-8"));
for (const [i, b64] of (data.frames as string[]).entries()) {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  try {
    const msg = PublicLobbyMessageSchema.parseBytes(bytes);
    const summary = (msg as any).type === "full"
      ? { type: "full", serverTime: msg.serverTime, gitCommit: (msg as any).gitCommit, active: (msg as any).active,
          games: Object.fromEntries(Object.entries((msg as any).games ?? {}).map(([k, v]: any) => [k, v.map((g: any) => ({ gameID: g.gameID, numClients: g.numClients, map: g.gameConfig?.gameMap, mode: g.gameConfig?.gameMode, maxPlayers: g.gameConfig?.maxPlayers, startsAt: g.startsAt, custom: g.custom, featured: g.featured, label: g.label, queueName: g.gameConfig?.initialCoins }))])) }
      : { type: (msg as any).type, serverTime: (msg as any).serverTime, counts: (msg as any).counts };
    console.log("FRAME", i, "=>", JSON.stringify(summary, null, 2).slice(0, 4000));
  } catch (e) {
    console.error("FRAME", i, "DECODE FAIL:", (e as Error).message?.slice(0, 300));
  }
}
