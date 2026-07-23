// Watchdog: se o heartbeat do poller parar de andar, sinaliza pro workflow religar.
// Sai com "stale" no GITHUB_OUTPUT quando o ultimo heartbeat tem mais de 8 minutos.
import { createClient } from "@libsql/client";
import { appendFileSync } from "fs";

const db = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
let hb = 0;
try {
  hb = Number((await db.execute("SELECT v FROM torres_kv WHERE k='heartbeat'")).rows[0]?.v || 0);
} catch (e) { console.error("erro lendo heartbeat:", String(e).slice(0, 150)); }
const ageMin = (Date.now() - hb) / 60000;
const stale = !hb || ageMin > 8 ? "1" : "0";
console.log(`heartbeat: ${hb ? Math.round(ageMin) + "min atras" : "inexistente"} -> stale=${stale}`);
appendFileSync(process.env.GITHUB_OUTPUT, `stale=${stale}\n`);
