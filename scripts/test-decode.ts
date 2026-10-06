import { PublicLobbyMessageSchema } from "../openfront-src/src/core/Schemas";

const hex = process.argv[2];
const bytes = new Uint8Array(Buffer.from(hex, "hex"));
try {
  const msg = PublicLobbyMessageSchema.parseBytes(bytes);
  console.log(JSON.stringify(msg, null, 2).slice(0, 3000));
} catch (e) {
  console.error("DECODE FAIL:", (e as Error).message?.slice(0, 500));
  const any = e as any;
  if (any.issues) console.error(JSON.stringify(any.issues.slice(0, 5)));
}
