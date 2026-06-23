/* ============================================================
   Robô CBO — Cloudflare Worker (cron 5 min)
   Mesmo motor de regras do dashboard. Começa em APPLY_MODE="dry"
   (só registra o que faria, NÃO aplica). Tudo baseado SÓ no dia de hoje (fuso BR).
   ============================================================ */

var API = 'https://graph.facebook.com/v21.0';
var RT_API = 'https://api.redtrack.io';

/* Config das regras — padroes (iguais ao dashboard). Podem ser sobrescritos por VARIAVEIS
   do Cloudflare (R_*), pra ajustar sem mexer no codigo. Veja buildRules(env). */
var RULES = {
  dayGood: 1.6, dayOk: 1.2,
  minSpendJudge: 100, floorDaily: 100,
  cpaTarget: 175, cpaRopeGood: 195, minRoas: 1.4,
  cutNoSaleSpend: 120,
  excRoas: 2.0, excMinSales: 3, scaleMult: 5, scaleUsePct: 0.2, releaseDaily: 500,
  alert3dRoas: 1.0, alert3dMinSpend: 150
};
/* Le os parametros das variaveis do Cloudflare (se existirem), senao usa o padrao acima. */
function buildRules(env) {
  var n = function(k, d) { var v = env && env[k]; var f = parseFloat(v); return (v !== undefined && v !== '' && !isNaN(f)) ? f : d; };
  return {
    dayGood: n('R_DAYGOOD', 1.6), dayOk: n('R_DAYOK', 1.2),
    minSpendJudge: n('R_MINSPEND', 100), floorDaily: n('R_FLOOR', 100),
    cpaTarget: n('R_CPATARGET', 175), cpaRopeGood: n('R_CPAROPE', 195), minRoas: n('R_MINROAS', 1.4),
    cutNoSaleSpend: n('R_CUTNOSALE', 120),
    excRoas: n('R_EXCROAS', 2.0), excMinSales: n('R_EXCMINSALES', 3), scaleMult: n('R_SCALEMULT', 5),
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
  var target = null, action = '';
  if (sales === 0) {
    if (sp >= RULES.cutNoSaleSpend) { target = RULES.floorDaily; action = 'CORTAR_100_SEM_VENDA'; }
    else action = 'COLETANDO';
  } else if (cpa <= ceiling) {
    var cur = currentDailyOf(c);
    if (roas >= RULES.excRoas && sales >= RULES.excMinSales && cur > 0 && sp >= RULES.scaleUsePct * cur) { target = cur * RULES.scaleMult; action = 'ESCALAR'; }
    else if (cur > 0 && cur < sp) { target = Math.max(RULES.releaseDaily, sp); action = 'AUMENTAR_LIBERA'; }
    else action = 'MANTER';
  } else if (roas >= RULES.minRoas) {
    target = Math.max(sp, RULES.floorDaily); action = 'LIMITAR_NO_GASTO';
  } else {
    target = RULES.floorDaily; action = 'CORTAR_100_ROAS_BAIXO';
  }
  var newEnd = (target && rem > 0) ? brDatePlus(Math.max(1, Math.ceil(rem / target))) : null;
  return { action: action, target: target, newEnd: newEnd, cpa: cpa, roas: roas, sales: sales, spend: sp };
}

/* ---------- coleta dados (Meta + RedTrack) ---------- */
async function collect(env) {
  var tokens = JSON.parse(env.META_TOKENS || '[]');
  var map = {};
  for (var ti = 0; ti < tokens.length; ti++) {
    var list = await fjPaged(API + '/me/adaccounts?fields=name,account_status&limit=100&access_token=' + tokens[ti]);
    list.forEach(function (a) { var id = a.id.replace('act_', ''); if (!map[id]) { map[id] = a; map[id]._tk = tokens[ti]; } });
  }
  var accounts = Object.values(map);
  var camps = [];
  for (var ai = 0; ai < accounts.length; ai++) {
    var acc = accounts[ai], an = (acc.name || '').toLowerCase();
    if (an.indexOf('effective 01') >= 0 || an.indexOf('origin') >= 0) continue;
    var cs = await fjPaged(API + '/' + acc.id + '/campaigns?fields=name,status,effective_status,lifetime_budget,stop_time&effective_status=["ACTIVE","PAUSED","IN_PROCESS","WITH_ISSUES"]&limit=100&access_token=' + acc._tk);
    cs.forEach(function (c) {
      var es = (c.effective_status || c.status || '').toUpperCase();
      if (es === 'DELETED' || es === 'ARCHIVED') return;
      if (c.name && c.name.toUpperCase().indexOf('CBO') >= 0 && c.lifetime_budget) {
        c._tk = acc._tk; c._acctStatus = acc.account_status; c._acctId = acc.id; camps.push(c);
      }
    });
  }
  // manter contas ativas OU com campanha ativa
  var keep = {};
  camps.forEach(function (c) { if (c._acctStatus === 1 || (c.effective_status || '').toUpperCase() === 'ACTIVE') keep[c._acctId] = true; });
  camps = camps.filter(function (c) { return keep[c._acctId]; });

  // gasto de hoje + lifetime (p/ saldo) por campanha
  var todayRange = encodeURIComponent(JSON.stringify({ since: brDatePlus(0), until: brDatePlus(0) }));
  var sinceLife = new Date(); sinceLife.setMonth(sinceLife.getMonth() - 36);
  var lifeRange = encodeURIComponent(JSON.stringify({ since: sinceLife.toISOString().split('T')[0], until: brDatePlus(0) }));
  for (var ci = 0; ci < camps.length; ci++) {
    var c = camps[ci];
    var today = await fj(API + '/' + c.id + '/insights?fields=spend&time_range=' + todayRange + '&access_token=' + c._tk).catch(function () { return {}; });
    var life = await fj(API + '/' + c.id + '/insights?fields=spend&time_range=' + lifeRange + '&access_token=' + c._tk).catch(function () { return {}; });
    c._spendToday = (today.data && today.data[0]) ? parseFloat(today.data[0].spend) || 0 : 0;
    c._spend = (life.data && life.data[0]) ? parseFloat(life.data[0].spend) || 0 : 0;
  }

  // vendas de hoje (RedTrack, por sub3 = campaign_id)
  if (env.RT_TOKEN) {
    var pType = env.RT_PTYPE || '1';
    var url = RT_API + '/report?api_key=' + encodeURIComponent(env.RT_TOKEN) + '&group=sub3&date_from=' + brDatePlus(0) + '&date_to=' + brDatePlus(0) + '&per=1000';
    var d = await fj(url).catch(function () { return {}; });
    var rows = d.items || d.data || d.report || (Array.isArray(d) ? d : []);
    var by = {};
    (Array.isArray(rows) ? rows : []).forEach(function (row) { if (row.sub3 != null) by[String(row.sub3)] = parseInt(row['convtype' + pType]) || 0; });
    camps.forEach(function (c) { c._sales = by[String(c.id)] || 0; });
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
  var actions = [];
  for (var i = 0; i < camps.length; i++) {
    var c = camps[i];
    var r = suggestRule(c, moodObj.mood);
    var alert3d = (c._spend3d >= RULES.alert3dMinSpend && (c._roas3d || 0) < RULES.alert3dRoas); // 3d opcional (não coletado aqui ainda)
    actions.push({ name: c.name, id: c.id, action: r.action, target: r.target, newEnd: r.newEnd, sales: r.sales, spend: Math.round(r.spend), cpa: isFinite(r.cpa) ? Math.round(r.cpa) : null, roas: +r.roas.toFixed(2) });

    if ((env.APPLY_MODE || 'dry') === 'live' && r.newEnd) {
      // cooldown 60 min por campanha
      var ck = 'cd:' + c.id, last = 0;
      try { last = parseInt(await env.RULES_KV.get(ck)) || 0; } catch (e) {}
      if (Date.now() - last >= 60 * 60 * 1000) {
        await applyChange(c, tokens, r.newEnd);
        try { await env.RULES_KV.put(ck, String(Date.now())); } catch (e) {}
      }
    }
  }
  var log = { at: new Date().toISOString(), mode: env.APPLY_MODE || 'dry', mood: moodObj.mood, moodRoas: +moodObj.roas.toFixed(2), count: camps.length, actions: actions };
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

    if (path === '/run') { var r = await run(env); return jsonResp(r); }

    var last = null; try { last = await env.RULES_KV.get('lastRun'); } catch (e) {}
    return new Response(last || '{"info":"sem execucao ainda. Acesse /run para rodar agora."}', { headers: Object.assign({ 'content-type': 'application/json' }, CORS) });
  }
};
