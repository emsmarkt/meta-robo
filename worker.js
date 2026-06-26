/* ============================================================
   Robô CBO — Cloudflare Worker (cron 5 min)
   Mesmo motor de regras do dashboard. Começa em APPLY_MODE="dry"
   (só registra o que faria, NÃO aplica). Tudo baseado SÓ no dia de hoje (fuso BR).
   ============================================================ */

var API = 'https://graph.facebook.com/v21.0';
var RT_API = 'https://api.redtrack.io';
var DIAG = {}; // diagnostico da ultima coleta (aparece no /run)

/* Config das regras — padroes (iguais ao dashboard). Podem ser sobrescritos por VARIAVEIS
   do Cloudflare (R_*), pra ajustar sem mexer no codigo. Veja buildRules(env). */
var RULES = {
  dayGood: 1.6, dayOk: 1.2,
  minSpendJudge: 100, floorDaily: 85,
  cpaTarget: 175, cpaRopeGood: 190, minRoas: 1.3, cutDays: 364,
  cutNoSaleSpend: 110,
  excRoas: 2.0, excMinSales: 3, scaleMult: 12, scaleUsePct: 0.2, releaseDaily: 500,
  aumRoasLow: 1.5, aumRoasHigh: 1.9, aumPctLow: 0.30, aumPctHigh: 0.70, aumMaxSales: 5,
  alert3dRoas: 1.0, alert3dMinSpend: 150
};
/* Le os parametros das variaveis do Cloudflare (se existirem), senao usa o padrao acima. */
function buildRules(env) {
  var n = function(k, d) { var v = env && env[k]; var f = parseFloat(v); return (v !== undefined && v !== '' && !isNaN(f)) ? f : d; };
  return {
    dayGood: n('R_DAYGOOD', 1.6), dayOk: n('R_DAYOK', 1.2),
    minSpendJudge: n('R_MINSPEND', 100), floorDaily: n('R_FLOOR', 85), cutDays: n('R_CUTDAYS', 364),
    cpaTarget: n('R_CPATARGET', 175), cpaRopeGood: n('R_CPAROPE', 190),
    minRoas: n('R_MINROAS', 1.3),
    cutNoSaleSpend: n('R_CUTNOSALE', 110),
    excRoas: n('R_EXCROAS', 2.0), excMinSales: n('R_EXCMINSALES', 3), scaleMult: n('R_SCALEMULT', 12),
    aumRoasLow: n('R_AUMROASLOW', 1.5), aumRoasHigh: n('R_AUMROASHIGH', 1.9), aumPctLow: n('R_AUMPCTLOW', 0.30), aumPctHigh: n('R_AUMPCTHIGH', 0.70), aumMaxSales: n('R_AUMMAXSALES', 5),
    scaleUsePct: n('R_SCALEUSEPCT', 0.2), releaseDaily: n('R_RELEASE', 500),
    alert3dRoas: n('R_ALERT3DROAS', 1.0), alert3dMinSpend: n('R_ALERT3DSPEND', 150)
  };
}

/* ---------- helpers de data (fuso BR fixo, UTC-3) ---------- */
function brDatePlus(days) {
  var d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function fj(url) { return fetch(url).then(function (r) { return r.json(); }); }
function fjPaged(url) {
  var all = [];
  function go(u) {
    return fj(u).then(function (d) {
      if (d && d.data && d.data.length) all = all.concat(d.data);
      if (d && d.paging && d.paging.next) return go(d.paging.next);
      return all;
    }).catch(function () { return all; });
  }
  return go(url);
}
function postForm(id, tk, params) {
  var body = new URLSearchParams();
  Object.keys(params).forEach(function (k) { body.append(k, params[k]); });
  body.append('access_token', tk);
  return fetch(API + '/' + id, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.error) throw new Error(d.error.message); return d; });
}
/* fallback de token: tenta o preferido e cai pros outros */
function withTokenFallback(toks, preferred, fn) {
  var ord = []; if (preferred) ord.push(preferred);
  toks.forEach(function (t) { if (t && t !== preferred) ord.push(t); });
  var i = 0, lastErr = null;
  function attempt() {
    if (i >= ord.length) return Promise.reject(lastErr || new Error('sem token'));
    var tk = ord[i++];
    return fn(tk).then(function (r) { return { result: r, tk: tk }; }, function (e) { lastErr = e; return attempt(); });
  }
  return attempt();
}

/* ---------- motor de regras (igual dashboard) ---------- */
function daysLeftOf(c) {
  if (!c.stop_time) return 0;
  var s = typeof c.stop_time === 'number' ? new Date(c.stop_time * 1000) : new Date(c.stop_time);
  var t = new Date(); t.setHours(0, 0, 0, 0);
  var d = Math.ceil((s - t) / 86400000);
  return d > 0 ? d : 0;
}
function remainingOf(c) { return (parseFloat(c.lifetime_budget) / 100) - (c._spend || 0); }
function currentDailyOf(c) { var dl = daysLeftOf(c), r = remainingOf(c); return (dl > 0 && r > 0) ? r / dl : 0; }
function computeMood(camps) {
  var rev = 0, sp = 0;
  camps.forEach(function (c) { rev += (c._sales || 0) * 260; sp += c._spendToday || 0; });
  var r = sp > 0 ? rev / sp : 0;
  return { roas: r, mood: r >= RULES.dayGood ? 'good' : (r >= RULES.dayOk ? 'normal' : 'bad') };
}
function suggestRule(c, mood) {
  var sp = c._spendToday || 0, sales = c._sales || 0;
  var roas = sp > 0 ? (sales * 260) / sp : 0;
  var cpa = sales > 0 ? sp / sales : Infinity;
  var rem = remainingOf(c);
  var ceiling = (mood === 'good' && sales >= 2) ? RULES.cpaRopeGood : RULES.cpaTarget;
  /* ROAS minimo aceitavel: <=2 vendas -> 1.3; 3+ vendas -> 1.3 (bom)/1.4 (normal)/1.5 (ruim). */
  var cutFloor = RULES.minRoas; /* 1.3 fixo, independente do dia/vendas */
  /* CORTAR = empurra termino p/ +cutDays (364). diario = saldo/364 -> newEnd = +364. */
  var cortarTarget = rem > 0 ? (rem / RULES.cutDays) : RULES.floorDaily;
  var target = null, action = '', key = '';
  if (sales === 0) {
    if (sp >= RULES.cutNoSaleSpend) { target = cortarTarget; action = 'CORTAR_TERMINO_364_SEM_VENDA'; key = 'CORTAR'; }
    else { action = 'COLETANDO'; key = 'COLETANDO'; }
  } else if (sales > RULES.aumMaxSales) {
    /* CAMPANHA COM VOLUME (>5 vendas): so REDUZ orcamento se ROAS < 1,3 (corte). ROAS >= 2,0
       (ou vende sem gasto hoje) ainda ESCALA. Entre 1,3 e 2,0 -> MANTER. Nunca LIMITAR/AUMENTAR. */
    if (roas < cutFloor) { target = cortarTarget; action = 'CORTAR_TERMINO_364_ROAS_BAIXO'; key = 'CORTAR'; }
    else if (roas >= RULES.excRoas || (sp < 1 && sales > 0)) { var baseDailyV = Math.max(sp, RULES.floorDaily); target = baseDailyV * RULES.scaleMult; action = 'ESCALAR'; key = 'ESCALAR'; }
    else { action = 'MANTER_VOLUME'; key = 'MANTER'; }
  } else if (cpa <= ceiling) {
    /* Base = GASTO REAL de hoje (nao o ritmo teorico saldo/dias, que gera escala absurda). */
    var baseDaily = Math.max(sp, RULES.floorDaily);
    var excellent = (roas >= RULES.excRoas) || (sp < 1 && sales > 0);
    if (excellent) { target = baseDaily * RULES.scaleMult; action = 'ESCALAR'; key = 'ESCALAR'; }
    else {
      var pct = Math.max(RULES.aumPctLow, Math.min(RULES.aumPctHigh, RULES.aumPctLow + (roas - RULES.aumRoasLow) / (RULES.aumRoasHigh - RULES.aumRoasLow) * (RULES.aumPctHigh - RULES.aumPctLow)));
      var formula = Math.max(RULES.floorDaily, sales * RULES.cpaTarget * (1 + pct));
      if (formula > sp) { target = formula; action = 'AUMENTAR_PROPORCIONAL'; key = 'AUMENTAR'; }
      else { action = 'MANTER'; key = 'MANTER'; }
    }
  } else if (roas >= cutFloor) {
    target = Math.max(sp, RULES.floorDaily); action = 'LIMITAR_NO_GASTO'; key = 'LIMITAR';
  } else {
    target = cortarTarget; action = 'CORTAR_TERMINO_364_ROAS_BAIXO'; key = 'CORTAR';
  }
  var newEnd = (target && rem > 0) ? brDatePlus(Math.max(1, Math.ceil(rem / target))) : null;
  return { action: action, key: key, target: target, newEnd: newEnd, cpa: cpa, roas: roas, sales: sales, spend: sp };
}

/* Busca o gasto vitalicio de varias campanhas em 1 chamada por token (Meta Batch API).
   Cada batch (ate 50 ops) conta como 1 subrequest do Worker. */
async function batchLifetimeSpend(camps, lifeRange) {
  var byTk = {};
  camps.forEach(function (c) { (byTk[c._tk] = byTk[c._tk] || []).push(c); });
  for (var tk in byTk) {
    var list = byTk[tk];
    for (var i = 0; i < list.length; i += 50) {
      var chunk = list.slice(i, i + 50);
      var batch = chunk.map(function (c) { return { method: 'GET', relative_url: c.id + '/insights?fields=spend&time_range=' + lifeRange }; });
      var body = new URLSearchParams();
      body.append('batch', JSON.stringify(batch));
      body.append('access_token', tk);
      try {
        var resp = await fetch(API + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        var arr = await resp.json();
        if (Array.isArray(arr)) {
          arr.forEach(function (item, idx) {
            var c = chunk[idx];
            try { var b = JSON.parse(item.body); c._spend = (b.data && b.data[0]) ? parseFloat(b.data[0].spend) || 0 : 0; } catch (e) { c._spend = 0; }
          });
        }
      } catch (e) { chunk.forEach(function (c) { c._spend = 0; }); }
    }
  }
}

/* ---------- coleta dados (Meta + RedTrack) ---------- */
async function collect(env) {
  var tokens = JSON.parse(env.META_TOKENS || '[]');
  var map = {};
  for (var ti = 0; ti < tokens.length; ti++) {
    var list = await fjPaged(API + '/me/adaccounts?fields=name,account_status&limit=100&access_token=' + tokens[ti]);
    list.forEach(function (a) { var id = a.id.replace('act_', ''); if (!map[id]) { map[id] = a; map[id]._tk = tokens[ti]; } });
  }
  var accounts = Object.values(map).filter(function (acc) { var an = (acc.name || '').toLowerCase(); return an.indexOf('effective 01') < 0 && an.indexOf('origin') < 0; });
  var camps = [];
  // Lista campanhas de TODAS as contas em LOTE por token (Meta Batch API) — poucos subrequests.
  var rel = 'campaigns?fields=name,status,effective_status,lifetime_budget,stop_time&effective_status=' + encodeURIComponent('["ACTIVE","PAUSED","IN_PROCESS","WITH_ISSUES"]') + '&limit=100';
  var accByTk = {};
  accounts.forEach(function (acc) { (accByTk[acc._tk] = accByTk[acc._tk] || []).push(acc); });
  for (var tk in accByTk) {
    var alist = accByTk[tk];
    for (var j = 0; j < alist.length; j += 50) {
      var achunk = alist.slice(j, j + 50);
      var bb = achunk.map(function (acc) { return { method: 'GET', relative_url: acc.id + '/' + rel }; });
      var body0 = new URLSearchParams(); body0.append('batch', JSON.stringify(bb)); body0.append('access_token', tk);
      try {
        var resp0 = await fetch(API + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body0.toString() });
        var arr0 = await resp0.json();
        if (Array.isArray(arr0)) {
          arr0.forEach(function (item, idx) {
            var acc = achunk[idx], cs = [];
            try { var b = JSON.parse(item.body); cs = b.data || []; } catch (e) {}
            cs.forEach(function (c) {
              var es = (c.effective_status || c.status || '').toUpperCase();
              if (es === 'DELETED' || es === 'ARCHIVED') return;
              if (c.name && c.name.toUpperCase().indexOf('CBO') >= 0 && c.name.toUpperCase().indexOf('SUBSTITUIDA') < 0 && c.lifetime_budget) {
                c._tk = acc._tk; c._acctStatus = acc.account_status; c._acctId = acc.id; camps.push(c);
              }
            });
          });
        }
      } catch (e) {}
    }
  }
  // manter contas ativas OU com campanha ativa
  var keep = {};
  camps.forEach(function (c) { if (c._acctStatus === 1 || (c.effective_status || '').toUpperCase() === 'ACTIVE') keep[c._acctId] = true; });
  camps = camps.filter(function (c) { return keep[c._acctId]; });

  // GASTO de hoje vem do RedTrack (abaixo). Aqui so o gasto VITALICIO (p/ saldo/remaining),
  // buscado em LOTE (Meta Batch API) p/ nao estourar o limite de subrequests do Worker.
  camps.forEach(function (c) { c._spendToday = 0; c._spend = 0; });
  var sinceLife = new Date(); sinceLife.setMonth(sinceLife.getMonth() - 36);
  var lifeRange = encodeURIComponent(JSON.stringify({ since: sinceLife.toISOString().split('T')[0], until: brDatePlus(0) }));
  await batchLifetimeSpend(camps, lifeRange);

  // vendas de hoje (RedTrack, por sub3 = campaign_id)
  DIAG = { rtTokenSet: !!env.RT_TOKEN, metaTokens: JSON.parse(env.META_TOKENS || '[]').length, today: brDatePlus(0), fx: parseFloat(env.R_FX) || 5.1, camps: camps.length };
  if (env.RT_TOKEN) {
    var pType = env.RT_PTYPE || '1';
    var url = RT_API + '/report?api_key=' + encodeURIComponent(env.RT_TOKEN) + '&group=sub3&date_from=' + brDatePlus(0) + '&date_to=' + brDatePlus(0) + '&per=1000';
    var d = {};
    try {
      var resp = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; CBORobo/1.0)' } });
      DIAG.rtHttp = resp.status;
      d = await resp.json();
    } catch (e) { DIAG.rtFetchErr = String((e && e.message) || e); d = {}; }
    var rows = d.items || d.data || d.report || (Array.isArray(d) ? d : []);
    DIAG.rtRows = Array.isArray(rows) ? rows.length : 0;
    DIAG.rtError = (d && d.error) ? (d.error.message || JSON.stringify(d.error)) : null;
    DIAG.rtSampleKeys = (Array.isArray(rows) && rows[0]) ? Object.keys(rows[0]).slice(0, 30).join(',') : '';
    DIAG.rtSampleSub3 = (Array.isArray(rows) && rows[0]) ? rows[0].sub3 : null;
    var fx = parseFloat(env.R_FX) || 5.1;
    var pickNum = function(o, ks){ for (var i=0;i<ks.length;i++){ var v=o[ks[i]]; if (v!=null && v!=='' && !isNaN(parseFloat(v))) return parseFloat(v); } return 0; };
    var by = {}, byCost = {};
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (row.sub3 != null) {
        /* Vendas = convtype{N}; se 0, cai pra 'approved' (algumas contas usam esse campo). */
        var s = parseInt(row['convtype' + pType]) || 0;
        if (!s) s = parseInt(row.approved) || 0;
        by[String(row.sub3)] = s;
        byCost[String(row.sub3)] = pickNum(row, ['cost','total_cost','spend','ad_cost']);
      }
    });
    camps.forEach(function (c) {
      c._sales = by[String(c.id)] || 0;
      /* GASTO pelo RedTrack (R$ -> US$), mesma fonte/fuso das vendas. Senao, mantem o do Meta. */
      var rc = byCost[String(c.id)] || 0;
      if (rc > 0) c._spendToday = rc / fx;
    });
  } else {
    camps.forEach(function (c) { c._sales = 0; });
  }
  return camps;
}

/* ---------- aplicar (só em APPLY_MODE=live) ---------- */
async function applyChange(c, tokens, newEnd) {
  var endIso = newEnd + 'T23:59:00-03:00';
  var endTs = Math.floor(new Date(endIso).getTime() / 1000);
  var campParams = { stop_time: String(endTs) };
  if (c.lifetime_budget) campParams.lifetime_budget = String(c.lifetime_budget);
  await withTokenFallback(tokens, c._tk, function (tk) { return postForm(c.id, tk, campParams); }).catch(function () {});
  var setsR = await withTokenFallback(tokens, c._tk, function (tk) { return fj(API + '/' + c.id + '/adsets?fields=id&limit=200&access_token=' + tk).then(function (r) { if (r.error) throw new Error(r.error.message); return r; }); }).catch(function () { return { result: {} }; });
  var sets = (setsR.result && setsR.result.data) || [];
  for (var i = 0; i < sets.length; i++) {
    await withTokenFallback(tokens, c._tk, function (tk) { return postForm(sets[i].id, tk, { end_time: endIso }); }).catch(function () {});
  }
}

/* ---------- execução principal ---------- */
async function run(env) {
  RULES = buildRules(env); // aplica os parametros das variaveis do Cloudflare (ou os padroes)
  // chave-mestra liga/desliga (KV). Default ligado.
  var enabled = true;
  try { var s = await env.RULES_KV.get('enabled'); if (s === 'off') enabled = false; } catch (e) {}
  if (!enabled) return { skipped: 'desligado pela chave-mestra (KV enabled=off)' };

  var tokens = JSON.parse(env.META_TOKENS || '[]');
  var camps = await collect(env);
  var moodObj = computeMood(camps);
  /* Mapa da ULTIMA regra aplicada por campanha (compartilhado c/ o dashboard). Usado p/ NAO
     reaplicar a MESMA regra consecutivamente (ex: LIMITAR nao repete enquanto a campanha fica
     na faixa). Se ela MUDAR de regra (ex: vira ESCALAR) e DEPOIS voltar pra LIMITAR, reaplica,
     porque a ultima aplicada passou a ser ESCALAR. Reseta no dia seguinte. */
  var appliedMap = {}; try { var am = await env.RULES_KV.get('applied'); if (am) appliedMap = JSON.parse(am); } catch (e) {}
  /* Historico append-only do robo (lista RICA, cap 500). So cresce quando aplica de verdade (live). */
  var histLog = []; try { var hl = await env.RULES_KV.get('histLog'); if (hl) { var ph = JSON.parse(hl); if (Array.isArray(ph)) histLog = ph; } } catch (e) {}
  var histDirty = false;
  var appliedDirty = false, today = brDatePlus(0);
  var actions = [];
  for (var i = 0; i < camps.length; i++) {
    var c = camps[i];
    var r = suggestRule(c, moodObj.mood);
    actions.push({ name: c.name, id: c.id, action: r.action, target: r.target, newEnd: r.newEnd, sales: r.sales, spend: Math.round(r.spend), cpa: isFinite(r.cpa) ? Math.round(r.cpa) : null, roas: +r.roas.toFixed(2) });

    if ((env.APPLY_MODE || 'dry') === 'live' && r.newEnd && r.key) {
      var prev = appliedMap[c.id];
      var sameAsLast = prev && prev.day === today && prev.sig === r.key; // a ULTIMA aplicada hoje ja foi essa mesma regra -> nao repete (mas reaplica se mudou e voltou)
      var ck = 'cd:' + c.id, last = 0;
      try { last = parseInt(await env.RULES_KV.get(ck)) || 0; } catch (e) {}
      if (!sameAsLast && (Date.now() - last >= 60 * 60 * 1000)) {
        await applyChange(c, tokens, r.newEnd);
        try { await env.RULES_KV.put(ck, String(Date.now())); } catch (e) {}
        appliedMap[c.id] = { sig: r.key, action: r.action, t: Date.now(), day: today };
        appliedDirty = true;
        /* Append RICO no historico do robo (cap 500, mais novo no topo). */
        histLog.unshift({
          id: c.id, name: c.name, t: Date.now(), day: today,
          sig: r.key, action: r.action,
          roas: +r.roas.toFixed(2), sales: r.sales, spend: Math.round(r.spend),
          dailyNew: r.target != null ? Math.round(r.target) : null, endNew: r.newEnd,
          source: 'robo'
        });
        if (histLog.length > 500) histLog = histLog.slice(0, 500);
        histDirty = true;
      }
    }
  }
  if (appliedDirty) { try { await env.RULES_KV.put('applied', JSON.stringify(appliedMap)); } catch (e) {} }
  if (histDirty) { try { await env.RULES_KV.put('histLog', JSON.stringify(histLog)); } catch (e) {} }
  var log = { at: new Date().toISOString(), mode: env.APPLY_MODE || 'dry', mood: moodObj.mood, moodRoas: +moodObj.roas.toFixed(2), count: camps.length, diag: DIAG, actions: actions };
  try { await env.RULES_KV.put('lastRun', JSON.stringify(log)); } catch (e) {}
  return log;
}

var CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function jsonResp(obj) { return new Response(JSON.stringify(obj), { headers: Object.assign({ 'content-type': 'application/json' }, CORS) }); }

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(request, env) {
    var path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    /* Estado COMPARTILHADO das regras aplicadas (todo mundo ve igual). Guardado no KV. */
    if (path === '/applied') {
      if (request.method === 'POST') {
        var body = {}; try { body = await request.json(); } catch (e) {}
        var map = {}; try { var s = await env.RULES_KV.get('applied'); if (s) map = JSON.parse(s); } catch (e) {}
        if (body && body.id) { map[body.id] = { sig: body.sig, action: body.action, t: Date.now(), day: brDatePlus(0) }; }
        try { await env.RULES_KV.put('applied', JSON.stringify(map)); } catch (e) {}
        return jsonResp({ ok: true });
      }
      var m = {}; try { var s2 = await env.RULES_KV.get('applied'); if (s2) m = JSON.parse(s2); } catch (e) {}
      return jsonResp(m);
    }

    /* Historico append-only COMPARTILHADO (lista RICA acumulada). Tem entradas do robo
       (source:'robo', so em APPLY_MODE=live) e MANUAIS (source:'manual') vindas do dashboard. */
    if (path === '/history') {
      if (request.method === 'POST') {
        /* Grava uma entrada MANUAL enviada pelo dashboard (todos os dispositivos veem). */
        var hb = {}; try { hb = await request.json(); } catch (e) {}
        if (!hb || !hb.id) return jsonResp({ ok: false, err: 'sem id' });
        var hlog = []; try { var hpost = await env.RULES_KV.get('histLog'); if (hpost) { var phPost = JSON.parse(hpost); if (Array.isArray(phPost)) hlog = phPost; } } catch (e) {}
        /* Entrada normalizada: preserva campos ricos do cliente, mas FORCA source:'manual'. */
        var entry = {
          id: hb.id, name: hb.name || ('#' + hb.id),
          t: (typeof hb.t === 'number' && hb.t > 0) ? hb.t : Date.now(),
          day: hb.day || brDatePlus(0),
          sig: hb.sig || '', action: hb.action || '',
          roas: hb.roas, sales: hb.sales, spend: hb.spend,
          dailyOld: (typeof hb.dailyOld === 'number') ? hb.dailyOld : null,
          dailyNew: (typeof hb.dailyNew === 'number') ? hb.dailyNew : null,
          endOld: hb.endOld || null, endNew: hb.endNew || null,
          source: 'manual'
        };
        /* Dedup defensivo contra reenvio: mesmo id+t+sig ja existe? Nao duplica. */
        var dup = false;
        for (var di = 0; di < hlog.length; di++) {
          var he = hlog[di];
          if (he && String(he.id) === String(entry.id) && he.t === entry.t && (he.sig || '') === entry.sig) { dup = true; break; }
        }
        if (!dup) { hlog.unshift(entry); if (hlog.length > 500) hlog = hlog.slice(0, 500); try { await env.RULES_KV.put('histLog', JSON.stringify(hlog)); } catch (e) {} }
        return jsonResp({ ok: true });
      }
      var hist = []; try { var hs = await env.RULES_KV.get('histLog'); if (hs) { var ph2 = JSON.parse(hs); if (Array.isArray(ph2)) hist = ph2; } } catch (e) {}
      return jsonResp(hist);
    }

    if (path === '/run') { var r = await run(env); return jsonResp(r); }

    var last = null; try { last = await env.RULES_KV.get('lastRun'); } catch (e) {}
    return new Response(last || '{"info":"sem execucao ainda. Acesse /run para rodar agora."}', { headers: Object.assign({ 'content-type': 'application/json' }, CORS) });
  }
};
