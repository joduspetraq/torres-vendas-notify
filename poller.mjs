// Poller de vendas TORRES — RedTrack -> ntfy (roda no GitHub Actions)
// Filtro: campanha começa com "TORRES" E payout > 0 (só venda de verdade)
// Estado (ids já notificados) fica em state/seen.json, commitado pelo workflow
import fs from "fs";

const API_KEY = process.env.REDTRACK_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC || "torres-vendas-kx9m42";
const STATE = "state/seen.json";
if (!API_KEY) { console.error("REDTRACK_API_KEY ausente"); process.exit(1); }

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const all = [];
let page = 1, total = Infinity;
while (all.length < total && page <= 5) {
  const r = await fetch(
    `https://api.redtrack.io/conversions?api_key=${API_KEY}&date_from=${day(-1)}&date_to=${day(0)}&limit=2000&page=${page}`
  );
  if (!r.ok) { console.error("RedTrack HTTP", r.status); process.exit(1); }
  const j = await r.json();
  total = j.total ?? 0;
  all.push(...(j.items || []));
  page++;
}

const vendas = all.filter(
  (c) => /^\s*TORRES/i.test(c.campaign || "") && Number(c.payout) > 0
);

let seen = {};
try { seen = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}

const novas = vendas.filter((c) => !seen[c.id]);
for (const c of novas) {
  seen[c.id] = Date.now();
  const valor = `$${Number(c.payout).toFixed(2)}`;
  const body = `${(c.campaign || "").trim()}\n${valor} — ${c.offer || c.type || "venda"} (${c.country || "?"})`;
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: `Venda! ${valor}`, Priority: "high", Tags: "moneybag" },
    body,
  });
  console.log("notificada:", c.id, valor, "ntfy:", res.status);
}

// limpa ids com mais de 3 dias
const cutoff = Date.now() - 3 * 86400000;
for (const [id, ts] of Object.entries(seen)) if (ts < cutoff) delete seen[id];
fs.writeFileSync(STATE, JSON.stringify(seen));
console.log(`ok — ${vendas.length} vendas TORRES no período, ${novas.length} novas`);
