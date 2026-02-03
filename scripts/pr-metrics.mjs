import fs from "node:fs";
import path from "node:path";

const {
  GH_TOKEN,
  PR_URL,
  LEGACY_REPO = "false",
  FUNCTIONAL_PR = "true",
  POST_COMMENT = "true",
  TZ = "America/Santo_Domingo",
  WORK_HOURS = "09:00-18:00",
  MORNING_CUTOFF = "07:30",
  COMMIT_REGEX = "^(feat|fix|chore|docs|style|refactor|test|perf|build|ci)(\\(.+\\))?: .+",
  BRANCH_REGEX = "^(feature|bugfix|hotfix|release)\\/[^\\s]+$",
  DECLINED_WINDOW_DAYS = "0",
} = process.env;

if (!GH_TOKEN) throw new Error("Missing secret GH_TOKEN (PR_METRICS_TOKEN).");
if (!PR_URL) throw new Error("Missing PR_URL input.");

const isLegacy = String(LEGACY_REPO).toLowerCase() === "true";
const isFunctional = String(FUNCTIONAL_PR).toLowerCase() === "true";
const postComment = String(POST_COMMENT).toLowerCase() === "true";
const declinedWindowDays = Number(DECLINED_WINDOW_DAYS || "0");

const commitRe = new RegExp(COMMIT_REGEX);
const branchRe = new RegExp(BRANCH_REGEX);

function parsePrUrl(url) {
  // https://github.com/OWNER/REPO/pull/123
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) throw new Error(`PR_URL inválido: ${url}`);
  return { owner: m[1], repo: m[2], pull_number: Number(m[3]) };
}

const apiBase = "https://api.github.com";

async function ghFetch(url, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status} ${res.statusText} on ${url}\n${text}`);
  }

  // 204 no content
  if (res.status === 204) return { data: null, headers: res.headers };
  const data = await res.json();
  return { data, headers: res.headers };
}

function getNextLink(headers) {
  const link = headers.get("link");
  if (!link) return null;
  // <url>; rel="next", <url>; rel="last"
  const parts = link.split(",").map(s => s.trim());
  for (const p of parts) {
    const m = p.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function paginate(url) {
  const out = [];
  let next = url;
  while (next) {
    const { data, headers } = await ghFetch(next);
    if (Array.isArray(data)) out.push(...data);
    else throw new Error(`Expected array pagination response: ${next}`);
    next = getNextLink(headers);
  }
  return out;
}

// --- Horario laboral (L-V 09:00-18:00) + regla 07:30 del doc ---
function parseTimeHHMM(t) {
  const [hh, mm] = t.split(":").map(Number);
  return { hh, mm };
}
const [workStartStr, workEndStr] = WORK_HOURS.split("-");
const workStart = parseTimeHHMM(workStartStr);
const workEnd = parseTimeHHMM(workEndStr);
const morningCutoff = parseTimeHHMM(MORNING_CUTOFF);

function toZonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, weekday: "short"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday, // Mon, Tue...
  };
}

function isWeekday(weekday) {
  return ["Mon","Tue","Wed","Thu","Fri"].includes(weekday);
}

function minutesSinceMidnight(h, m) { return h * 60 + m; }

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

/**
 * Calcula minutos "laborales" entre start y end, según reglas del documento:
 * - L-V 09:00-18:00 (configurable)
 * - Si se abre fuera de horario y se cierra antes de 07:30, se cuentan todas las horas
 * - Si se abre fuera de horario y se cierra después de 07:30, solo cuenta desde 07:30
 */
function businessMinutesBetween(startUtc, endUtc, tz) {
  if (endUtc <= startUtc) return 0;

  // Regla especial: start fuera de horario laboral
  const sp = toZonedParts(startUtc, tz);
  const ep = toZonedParts(endUtc, tz);

  const startMin = minutesSinceMidnight(sp.hour, sp.minute);
  const endMin = minutesSinceMidnight(ep.hour, ep.minute);
  const ws = minutesSinceMidnight(workStart.hh, workStart.mm);
  const we = minutesSinceMidnight(workEnd.hh, workEnd.mm);
  const cutoffMin = minutesSinceMidnight(morningCutoff.hh, morningCutoff.mm);

  const startInWork = isWeekday(sp.weekday) && startMin >= ws && startMin <= we;
  const endBeforeCutoffSameOrNext = endMin <= cutoffMin;

  // Si se abrió fuera horario y se cerró antes del cutoff -> cuenta todo
  if (!startInWork && endBeforeCutoffSameOrNext) {
    return Math.round((endUtc - startUtc) / 60000);
  }

  // Si se abrió fuera horario y se cerró después del cutoff -> desde cutoff (en día de cierre)
  // Para simplificar: en el primer día, arrancamos en max(start, cutoff del día de cierre si corresponde)
  // Implementación robusta: iterar por minutos en días (por chunks de día)
  let total = 0;
  let cur = new Date(startUtc);

  while (cur < endUtc) {
    const p = toZonedParts(cur, tz);
    const dayStart = new Date(cur);
    // avanzar a medianoche local es complejo sin librerías; aproximamos por ventanas de 24h UTC y
    // usamos las partes zoned para filtros. Para métricas, esto suele ser suficiente.
    const next = new Date(Math.min(endUtc.getTime(), cur.getTime() + 60 * 60 * 1000)); // 1h chunks

    const pNext = toZonedParts(next, tz);
    // si cambia de día, igual seguimos por chunks

    // calcula superposición de [cur,next] con [workStart,workEnd] en ese día local
    if (isWeekday(p.weekday)) {
      const curMin = minutesSinceMidnight(p.hour, p.minute);
      const nextMin = minutesSinceMidnight(pNext.hour, pNext.minute);

      // si estamos en el día de cierre y aplica cutoff, ajustamos inicio mínimo
      let effectiveStart = ws;
      if (!startInWork) effectiveStart = Math.max(ws, cutoffMin);

      const a = clamp(curMin, effectiveStart, we);
      const b = clamp(nextMin, effectiveStart, we);

      // si en ese chunk cruzamos el rango laboral
      if (b > a) total += (b - a);
    }

    cur = next;
  }

  return total;
}

// --- Scoring helper ---
function scoreByThresholds(value, thresholdsAsc) {
  // thresholdsAsc: [{min,max,score}] or a function; aquí usaremos rangos explícitos por claridad
  for (const t of thresholdsAsc) {
    const okMin = (t.min === undefined) || (value >= t.min);
    const okMax = (t.max === undefined) || (value <= t.max);
    if (okMin && okMax) return t.score;
  }
  return 1;
}

function round1(x) { return Math.round(x * 10) / 10; }
function weightedAvg(items) {
  const num = items.reduce((s, it) => s + it.score * it.weight, 0);
  const den = items.reduce((s, it) => s + it.weight, 0);
  return den ? (num / den) : 0;
}

// --- Umbrales del documento (y legacy) ---
function thresholdsCommitsCount() {
  // M1.3 Cantidad commits: >=8 => 1, 6-7 =>2, 5=>3, 3-4=>4, 1-2=>5
  return [
    { min: 8, score: 1 },
    { min: 6, max: 7, score: 2 },
    { min: 5, max: 5, score: 3 },
    { min: 3, max: 4, score: 4 },
    { min: 1, max: 2, score: 5 },
  ];
}
function thresholdsAvgFilesPerCommit(legacy) {
  // M1.4 (normal): >=40 =>1, >=30<40=>2, >=20<30=>3, >=15<20=>4, <15=>5
  // legacy: >=60=>1, >=50<60=>2, >=40<50=>3, >=35<40=>4, <35=>5
  if (!legacy) {
    return [
      { min: 40, score: 1 },
      { min: 30, max: 39.999, score: 2 },
      { min: 20, max: 29.999, score: 3 },
      { min: 15, max: 19.999, score: 4 },
      { max: 14.999, score: 5 },
    ];
  }
  return [
    { min: 60, score: 1 },
    { min: 50, max: 59.999, score: 2 },
    { min: 40, max: 49.999, score: 3 },
    { min: 35, max: 39.999, score: 4 },
    { max: 34.999, score: 5 },
  ];
}
function thresholdsAvgLinesPerCommit(legacy) {
  // M1.5 (normal): >=350=>1, >=250<350=>2, >=150<250=>3, >=100<150=>4, <100=>5
  // legacy: >=400=>1, >=300<400=>2, >=200<300=>3, >=150<200=>4, <150=>5
  if (!legacy) {
    return [
      { min: 350, score: 1 },
      { min: 250, max: 349.999, score: 2 },
      { min: 150, max: 249.999, score: 3 },
      { min: 100, max: 149.999, score: 4 },
      { max: 99.999, score: 5 },
    ];
  }
  return [
    { min: 400, score: 1 },
    { min: 300, max: 399.999, score: 2 },
    { min: 200, max: 299.999, score: 3 },
    { min: 150, max: 199.999, score: 4 },
    { max: 149.999, score: 5 },
  ];
}
function thresholdsLinesModified(legacy) {
  // M3.2 normal: >1200=>1, >500<=1200=>2, >300<=500=>3, >50<=300=>4, <=50=>5
  // legacy: >1200=>1, >700<=1200=>2, >500<=700=>3, >100<=500=>4, <=100=>5
  if (!legacy) {
    return [
      { min: 1200.0001, score: 1 },
      { min: 500.0001, max: 1200, score: 2 },
      { min: 300.0001, max: 500, score: 3 },
      { min: 50.0001, max: 300, score: 4 },
      { max: 50, score: 5 },
    ];
  }
  return [
    { min: 1200.0001, score: 1 },
    { min: 700.0001, max: 1200, score: 2 },
    { min: 500.0001, max: 700, score: 3 },
    { min: 100.0001, max: 500, score: 4 },
    { max: 100, score: 5 },
  ];
}

function thresholdsCloseTimeHours(complexity) {
  // M3.1 depende si complejidad >3 o <=3 (según tabla del doc)
  // Usamos el bloque <=3 como "simple" y >3 como "complejo"
  const complex = complexity > 3;

  if (complex) {
    return [
      { min: 32.0001, score: 1 },
      { min: 20.0001, max: 32, score: 2 },
      { min: 8.0001, max: 20, score: 3 },
      { min: 4.0001, max: 8, score: 4 },
      { max: 4, score: 5 },
    ];
  }
  // <=3: incluye extremos raros (>32 o <=0.5) como score 1
  return [
    { min: 32.0001, score: 1 },
    { max: 0.5, score: 1 },
    { min: 20.0001, max: 32, score: 2 },
    { min: 0.5001, max: 1, score: 2 },
    { min: 8.0001, max: 20, score: 3 },
    { min: 4.0001, max: 8, score: 4 },
    { max: 4, score: 5 },
  ];
}

function thresholdsObservations(complexity) {
  // M4.1 según tabla del doc (comentarios + tareas resueltas)
  // Implementación aproximada basada en condiciones explícitas.
  if (complexity >= 1 && complexity < 3) {
    return [
      { max: 0, score: 1 },
      { min: 1, max: 1, score: 2 },               // 1 comentario
      { min: 2, max: 5, score: 3 },               // >1 y <=5
      { min: 6, max: 10, score: 4 },              // >5 y <=10
      { min: 11, score: 5 },                      // >5 tareas resueltas es difícil; usamos 11+ como proxy
    ];
  }
  if (complexity >= 3 && complexity < 4) {
    return [
      { max: 0, score: 2 },                       // 0 => 2
      { min: 1, max: 2, score: 3 },               // >=1 y <3
      { min: 3, score: 4 },                       // >=3
    ];
  }
  if (complexity >= 4 && complexity < 5) {
    return [
      { max: 0, score: 3 },                       // 0 => 3
      { min: 1, score: 4 },                       // >=1 => 4
      { min: 2, score: 5 },                       // >=2 tareas resueltas; proxy 2+
    ];
  }
  // complexity == 5
  return [
    { max: 0, score: 4 },                         // 0 => 4
    { min: 1, score: 5 },                         // >=1 => 5
  ];
}

// --- Main ---
const { owner, repo, pull_number } = parsePrUrl(PR_URL);

// 1) Pull request base info
const pr = (await ghFetch(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}`)).data;

// 2) Files, commits, reviews, comments
const commits = await paginate(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/commits?per_page=100`);
const files = await paginate(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=100`);
const reviews = await paginate(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=100`);
const issueComments = await paginate(`${apiBase}/repos/${owner}/${repo}/issues/${pull_number}/comments?per_page=100`);
const reviewComments = await paginate(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/comments?per_page=100`);

// 3) GraphQL: reviewThreads isResolved
const gqlQuery = `
query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}`;
//async function gqlAllThreads() {
//  let after = null;
//  let all = [];
//  while (true) {
//    const body = { query: gqlQuery, variables: { owner, repo, number: pull_number, after } };
//    const { data } = await ghFetch(`${apiBase}/graphql`, { method: "POST", body });
//    const conn = data.repository.pullRequest.reviewThreads;
//    all.push(...conn.nodes);
//    if (!conn.pageInfo.hasNextPage) break;
//    after = conn.pageInfo.endCursor;
//  }
//  return all;
//}
async function gqlAllThreads() {
  let after = null;
  let all = [];
  while (true) {
    const body = { query: gqlQuery, variables: { owner, repo, number: pull_number, after } };
    
    // 1. Recibimos el cuerpo completo de la respuesta (responseBody)
    const { data: responseBody } = await ghFetch(`${apiBase}/graphql`, { method: "POST", body });

    // 2. Manejo de Errores de GraphQL (GraphQL suele devolver status 200 incluso con errores)
    if (responseBody.errors) {
      console.error("❌ Error devuelto por GraphQL:", JSON.stringify(responseBody.errors, null, 2));
      throw new Error(`GraphQL Error: ${responseBody.errors[0].message}`);
    }

    // 3. Validación de estructura (responseBody.data.repository)
    if (!responseBody.data || !responseBody.data.repository) {
      console.error("❌ Respuesta inesperada (data o repository es null):", JSON.stringify(responseBody, null, 2));
      throw new Error("No se pudo acceder al repositorio mediante GraphQL. Verifica permisos del token.");
    }

    // 4. Acceso correcto a la propiedad anidada
    const conn = responseBody.data.repository.pullRequest.reviewThreads;
    
    all.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return all;
}
const threads = await gqlAllThreads();
const resolvedThreads = threads.filter(t => t.isResolved).length;
const unresolvedThreads = threads.filter(t => !t.isResolved).length;

// --- Derived data ---
const totalCommits = commits.length;
const totalChangedFiles = files.length;
const linesModified = (pr.additions || 0) + (pr.deletions || 0);

const headBranch = pr.head?.ref || "";
const branchOk = branchRe.test(headBranch);

// approvals
const approvers = new Set(reviews.filter(r => r.state === "APPROVED").map(r => r.user?.login).filter(Boolean));
const approvalsCount = approvers.size;

// declined PRs metric (simple mode)
const isClosed = pr.state === "closed";
const isMerged = Boolean(pr.merged_at);
const declinedThisPr = (isClosed && !isMerged) ? 1 : 0;

// Commit-level details (files per commit + lines per commit)
// Para cada commit pedimos /commits/{sha} (puede ser N llamadas; típico manejable)
const excludedTypes = new Set(["chore","style","docs"]);
function parseCommitType(msg) {
  const m = msg.match(/^(\w+)(\(.+\))?:\s/);
  return m ? m[1] : null;
}
let sumFiles = 0;
let sumLines = 0;
let countForAverages = 0;
let commitsStandardOk = 0;

for (const c of commits) {
  const msg = c.commit?.message?.split("\n")[0] || "";
  if (commitRe.test(msg)) commitsStandardOk++;

  const type = parseCommitType(msg);

  // Excluir chore/style/docs SOLO para promedios de archivos/commit y líneas/commit
  const exclude = type && excludedTypes.has(type);

  const sha = c.sha;
  const commitDetails = (await ghFetch(`${apiBase}/repos/${owner}/${repo}/commits/${sha}`)).data;

  const fileCount = (commitDetails.files || []).length;
  const totalLines = (commitDetails.stats?.total ?? 0);

  if (!exclude) {
    sumFiles += fileCount;
    sumLines += totalLines;
    countForAverages++;
  }
}

const avgFilesPerCommit = countForAverages ? (sumFiles / countForAverages) : 0;
const avgLinesPerCommit = countForAverages ? (sumLines / countForAverages) : 0;

const commitStandardPct = totalCommits ? (commitsStandardOk / totalCommits) : 0;

// M1.4/M1.5 scoring thresholds from doc
const s_commitsCount = scoreByThresholds(totalCommits, thresholdsCommitsCount());
const s_avgFiles = scoreByThresholds(avgFilesPerCommit, thresholdsAvgFilesPerCommit(isLegacy));
const s_avgLines = scoreByThresholds(avgLinesPerCommit, thresholdsAvgLinesPerCommit(isLegacy));

// Commit standard scoring (no está en el doc; hacemos regla configurable)
const s_commitStandard =
  commitStandardPct >= 0.9 ? 5 :
  commitStandardPct >= 0.75 ? 4 :
  commitStandardPct >= 0.6 ? 3 :
  commitStandardPct >= 0.4 ? 2 : 1;

// M3.2 score
const s_linesModified = scoreByThresholds(linesModified, thresholdsLinesModified(isLegacy));

// Complejidad (si no funcional => 5)
let complexity;
if (!isFunctional) {
  complexity = 5;
} else {
  // complejidad como promedio ponderado de scores, redondeado 1..5
  const comp = weightedAvg([
    { score: s_commitsCount, weight: 0.20 },
    { score: s_avgFiles,     weight: 0.25 },
    { score: s_avgLines,     weight: 0.25 },
    { score: s_linesModified,weight: 0.30 },
  ]);
  complexity = Math.min(5, Math.max(1, Math.round(comp)));
}

// M3.1 close time in business hours
const createdAt = new Date(pr.created_at);
const closedAt = pr.closed_at ? new Date(pr.closed_at) : new Date(); // si está abierto, hasta ahora
const businessMins = businessMinutesBetween(createdAt, closedAt, TZ);
const closeHours = businessMins / 60;
const s_closeTime = scoreByThresholds(closeHours, thresholdsCloseTimeHours(complexity));

// Observaciones (comentarios + tareas resueltas)
const totalComments = issueComments.length + reviewComments.length;
const observations = totalComments + resolvedThreads;
const s_observations = scoreByThresholds(observations, thresholdsObservations(complexity));

// M2 approvals scoring from doc table
const s_approvals =
  approvalsCount > 2 ? 5 :
  approvalsCount === 2 ? 4 :
  approvalsCount === 1 ? 3 :
  approvalsCount === 0 ? 2 : 1;

// M2 declined scoring (si se usa solo este PR)
let s_declined = declinedThisPr === 0 ? 5 : 3; // proxy simple
// si quieres histórico, aquí podrías implementar búsqueda por autor/ventana
if (declinedWindowDays > 0) {
  // (Opcional) Implementación histórica se deja como extensión
  // Para mantener el ejemplo simple, lo señalamos en el reporte.
}

// Branch naming
const s_branch = branchOk ? 5 : 2;

// Métricas M1..M4
const M1 = weightedAvg([
  { score: s_commitsCount,   weight: 0.30 },
  { score: s_avgFiles,       weight: 0.20 },
  { score: s_avgLines,       weight: 0.20 },
  { score: s_commitStandard, weight: 0.30 },
]);

const M2 = weightedAvg([
  { score: s_approvals, weight: 0.50 },
  { score: s_declined,  weight: 0.20 },
  { score: s_branch,    weight: 0.30 },
]);

const M3 = weightedAvg([
  { score: s_closeTime,     weight: 0.75 },
  { score: s_linesModified, weight: 0.25 },
]);

const M4 = weightedAvg([
  { score: s_observations, weight: 1.00 },
]);

// Nivel de madurez total (M1..M4 con pesos + M5 penalización)
let maturity =
  (M1 * 0.25) +
  (M2 * 0.15) +
  (M3 * 0.35) +
  (M4 * 0.25);

const ageDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
const m5Penalty = (pr.state === "open" && ageDays > 7) ? 0.5 : 0;
maturity = maturity - m5Penalty;

// --- Build markdown report ---
const reportLines = [];
reportLines.push(`# 📌 Reporte de Métricas Code Review (por PR)`);
reportLines.push(`**PR:** ${PR_URL}`);
reportLines.push(`**Repo:** \`${owner}/${repo}\``);
reportLines.push(`**Estado:** ${pr.state}${isMerged ? " (MERGED)" : ""}`);
reportLines.push(`**Complejidad (1-5):** **${complexity}**`);
reportLines.push(`**Nivel de madurez (1-5):** **${round1(maturity)}** ${m5Penalty ? `(incluye penalización M5: -0.5)` : ""}`);
reportLines.push(``);
reportLines.push(`---`);
reportLines.push(`## M1 – Manejo de Commits (peso 0.25)`);
reportLines.push(`- Commits en PR: **${totalCommits}** → score **${s_commitsCount}**`);
reportLines.push(`- Prom. archivos/commit (excluye chore/style/docs): **${round1(avgFilesPerCommit)}** → score **${s_avgFiles}**`);
reportLines.push(`- Prom. líneas/commit (excluye chore/style/docs): **${round1(avgLinesPerCommit)}** → score **${s_avgLines}**`);
reportLines.push(`- Estándar commits: **${Math.round(commitStandardPct * 100)}%** cumplen regex → score **${s_commitStandard}**`);
reportLines.push(`- **M1:** **${round1(M1)}**`);
reportLines.push(``);
reportLines.push(`## M2 – Creación de Pull Request (peso 0.15)`);
reportLines.push(`- Aprobadores únicos: **${approvalsCount}** → score **${s_approvals}**`);
reportLines.push(`- Declinados (modo simple): **${declinedThisPr}** → score **${s_declined}**`);
reportLines.push(`- Branch: \`${headBranch}\` → ${branchOk ? "✅ cumple" : "❌ no cumple"} → score **${s_branch}**`);
reportLines.push(`- **M2:** **${round1(M2)}**`);
reportLines.push(``);
reportLines.push(`## M3 – Revisión de Pull Request (peso 0.35)`);
reportLines.push(`- Tiempo “hábil” abierto (${TZ}, ${WORK_HOURS}): **${round1(closeHours)}h** → score **${s_closeTime}**`);
reportLines.push(`- Líneas modificadas (add+del): **${linesModified}** → score **${s_linesModified}**`);
reportLines.push(`- **M3:** **${round1(M3)}**`);
reportLines.push(``);
reportLines.push(`## M4 – Observaciones en PR (peso 0.25)`);
reportLines.push(`- Comentarios (issue + review): **${totalComments}**`);
reportLines.push(`- Threads resueltos: **${resolvedThreads}** | no resueltos: **${unresolvedThreads}**`);
reportLines.push(`- Observaciones (comentarios + resueltos): **${observations}** → score **${s_observations}**`);
reportLines.push(`- **M4:** **${round1(M4)}**`);
reportLines.push(``);
reportLines.push(`---`);
reportLines.push(`## Recomendaciones rápidas`);
if (s_commitsCount <= 2) reportLines.push(`- 🔧 Considera **reducir/ordenar** commits (evitar PR con muchos commits).`);
if (s_avgFiles <= 2) reportLines.push(`- 🧩 Divide cambios por commit: demasiados archivos por commit dificultan la review.`);
if (s_avgLines <= 2) reportLines.push(`- ✂️ Procura commits más pequeños (menos líneas por commit).`);
if (s_commitStandard <= 3) reportLines.push(`- 🏷️ Mejora consistencia de mensajes de commit (regex actual: \`${COMMIT_REGEX}\`).`);
if (!branchOk) reportLines.push(`- 🌿 Ajusta nombre de branch según regex: \`${BRANCH_REGEX}\`.`);
if (unresolvedThreads > 0) reportLines.push(`- ✅ Cierra conversaciones: hay **${unresolvedThreads}** threads sin resolver.`);
if (s_closeTime <= 2) reportLines.push(`- ⏱️ PR con ventana hábil alta: intenta acelerar ciclos de revisión.`);
reportLines.push(``);
reportLines.push(`> Nota: “declinados” en el documento suele ser una métrica histórica; en este reporte está en modo simple (solo este PR), configurable.`);

const report = reportLines.join("\n");

// write report artifact
fs.mkdirSync("output", { recursive: true });
fs.writeFileSync(path.join("output", "report.md"), report, "utf8");

// write summary in Actions UI
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  fs.appendFileSync(summaryPath, report + "\n");
}

// Optionally post comment on PR (issue comment endpoint)
if (postComment) {
  await ghFetch(`${apiBase}/repos/${owner}/${repo}/issues/${pull_number}/comments`, {
    method: "POST",
    body: { body: report },
  });
}
console.log("Done. Report generated.");
