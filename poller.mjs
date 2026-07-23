// Poller de vendas TORRES — RedTrack -> ntfy (roda no GitHub Actions)
// Filtro: campanha começa com "TORRES" E payout > 0 (só venda de verdade)
// Estado (dedupe) no TURSO (db ds24-webhook, tabela torres_seen) — o esquema antigo de
// commitar state/seen.json no git perdia estado (fila do Actions + rebase conflict)
// e causava rajadas de notificação duplicada + atrasos.
import { createClient } from "@libsql/client";

const API_KEY = process.env.REDTRACK_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
if (!API_KEY || !NTFY_TOPIC || !process.env.TURSO_URL || !process.env.TURSO_TOKEN) {
  console.error("secret ausente (REDTRACK_API_KEY/NTFY_TOPIC/TURSO_URL/TURSO_TOKEN)");
  process.exit(1);
}
const db = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });

await db.execute("CREATE TABLE IF NOT EXISTS torres_seen (id TEXT PRIMARY KEY, ts INTEGER)");
await db.execute("CREATE TABLE IF NOT EXISTS torres_kv (k TEXT PRIMARY KEY, v TEXT)");
const kvSet = (k, v) => db.execute({ sql: "INSERT INTO torres_kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", args: [k, String(v)] });
const kvGet = async (k) => (await db.execute({ sql: "SELECT v FROM torres_kv WHERE k=?", args: [k] })).rows[0]?.v;

// heartbeat: prova que o loop ta vivo (o watchdog religa se isso parar de andar)
await kvSet("heartbeat", Date.now());

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const all = [];
try {
  let page = 1, total = Infinity;
  while (all.length < total && page <= 5) {
    const r = await fetch(
      `https://api.redtrack.io/conversions?api_key=${API_KEY}&date_from=${day(-1)}&date_to=${day(0)}&limit=2000&page=${page}`,
      { signal: AbortSignal.timeout(30000) } // sem isso o job pendura quando o RT congela a conexao
    );
    if (!r.ok) throw new Error("RedTrack HTTP " + r.status);
    const j = await r.json();
    total = j.total ?? 0;
    all.push(...(j.items || []));
    page++;
  }
} catch (e) {
  // RT fora do ar: conta falhas seguidas e avisa UMA vez por janela de problema
  const fails = Number(await kvGet("rt_fails") || 0) + 1;
  await kvSet("rt_fails", fails);
  console.error("RT falhou (" + fails + "x seguidas):", String(e).slice(0, 150));
  if (fails === 10) {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      signal: AbortSignal.timeout(20000), method: "POST",
      headers: { Title: "⚠️ Poller sem conseguir ler o RedTrack", Priority: "default", Tags: "warning" },
      body: "~10min de falhas seguidas na API do RT. Vendas serão notificadas quando voltar (sem duplicar).",
    }).catch(() => {});
  }
  process.exit(0);
}
await kvSet("rt_fails", 0);

const vendas = all.filter((c) => /^\s*TORRES/i.test(c.campaign || "") && Number(c.payout) > 0);

// primeira execucao com tabela vazia: marca tudo como visto SEM notificar (migracao do seen.json)
const count = Number((await db.execute("SELECT COUNT(*) n FROM torres_seen")).rows[0].n);
if (count === 0 && vendas.length) {
  for (const c of vendas) await db.execute({ sql: "INSERT OR IGNORE INTO torres_seen (id, ts) VALUES (?,?)", args: [c.id, Date.now()] });
  console.log("bootstrap: " + vendas.length + " vendas marcadas como vistas, nada notificado");
  process.exit(0);
}

// novas = ainda nao vistas (dedupe central no Turso — imune a estado local perdido)
const novas = [];
for (const c of vendas) {
  const seen = (await db.execute({ sql: "SELECT 1 FROM torres_seen WHERE id=?", args: [c.id] })).rows.length;
  if (!seen) novas.push(c);
}

for (const c of novas) {
  // grava ANTES de notificar (crash nunca gera duplicada); se o ntfy falhar, desfaz pra retentar
  await db.execute({ sql: "INSERT OR IGNORE INTO torres_seen (id, ts) VALUES (?,?)", args: [c.id, Date.now()] });
  const valor = `$${Number(c.payout).toFixed(2)}`;
  const hora = c.created_at
    ? new Date(c.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })
    : "";
  const body = `${(c.campaign || "").trim()}\n${valor} — ${c.offer || c.type || "venda"} (${c.country || "?"})${hora ? ` às ${hora}` : ""}`;
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      signal: AbortSignal.timeout(20000),
      method: "POST",
      headers: { Title: `Venda! ${valor}`, Priority: "high", Tags: "moneybag" },
      body,
    });
    if (!res.ok) throw new Error("ntfy HTTP " + res.status);
    console.log("notificada (ntfy " + res.status + ")");
  } catch (e) {
    await db.execute({ sql: "DELETE FROM torres_seen WHERE id=?", args: [c.id] });
    console.error("ntfy falhou, vai retentar no proximo ciclo:", String(e).slice(0, 120));
  }
}

// limpa ids com mais de 3 dias
await db.execute({ sql: "DELETE FROM torres_seen WHERE ts < ?", args: [Date.now() - 3 * 86400000] });
console.log(`ok — ${novas.length} novas`);
