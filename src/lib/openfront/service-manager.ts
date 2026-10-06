// Superviseur du mini-service bun (mini-services/openfront-service).
//
// Les processus lancés en arrière-plan depuis une commande bash du sandbox
// sont nettoyés à la fin de l'appel : le service OpenFront est donc démarré
// ET surveillé par le serveur Next.js lui-même (processus persistant).
// À chaque appel : /health est vérifié ; si le service est absent, il est
// relancé (spawn détaché). Le service est auto-réparant.
import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const SERVICE_URL = "http://localhost:3020";
const SERVICE_DIR = path.join(process.cwd(), "mini-services", "openfront-service");
const BUN = "/usr/local/bin/bun";

interface ManagerState {
  spawning: boolean;
  spawnedAt: number;
  lastCheckOk: number;
}

const g = globalThis as unknown as { __ofServiceManager?: ManagerState };

function state(): ManagerState {
  if (!g.__ofServiceManager) {
    g.__ofServiceManager = { spawning: false, spawnedAt: 0, lastCheckOk: 0 };
  }
  return g.__ofServiceManager;
}

async function checkHealth(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVICE_URL}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function spawnService(): void {
  const s = state();
  if (s.spawning) return;
  if (!existsSync(path.join(SERVICE_DIR, "index.ts"))) {
    console.warn("[service-manager] index.ts introuvable:", SERVICE_DIR);
    return;
  }
  s.spawning = true;
  s.spawnedAt = Date.now();
  try {
    const child = spawn(
      BUN,
      ["--hot", "index.ts"],
      {
        cwd: SERVICE_DIR,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, PORT: "3020" },
      },
    );
    child.unref();
    console.log(`[service-manager] mini-service relancé (pid ${child.pid})`);
  } catch (err) {
    console.warn("[service-manager] spawn échoué:", (err as Error).message);
  } finally {
    // Délai de garde anti-spawn multiple (hot reload inclus).
    setTimeout(() => {
      state().spawning = false;
    }, 5000).unref?.();
  }
}

/** Garantit que le mini-service tourne (vérifie, relance si besoin). */
export async function ensureService(): Promise<boolean> {
  const s = state();
  if (await checkHealth()) {
    s.lastCheckOk = Date.now();
    return true;
  }
  spawnService();
  // Attend jusqu'à 12 s le démarrage du service.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await checkHealth()) {
      s.lastCheckOk = Date.now();
      return true;
    }
  }
  return false;
}
