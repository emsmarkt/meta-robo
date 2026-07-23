/* ============================================================
   Robô CBO — Cloudflare Worker (cron 5 min)
   Mesmo motor de regras do dashboard. Começa em APPLY_MODE="dry"
   (só registra o que faria, NÃO aplica). Tudo baseado SÓ no dia de hoje (fuso BR).
   ============================================================ */

var API = 'https://graph.facebook.com/v21.0';
var RT_API = 'https://api.redtrack.io';
var DIAG = {}; // diagnostico da ultima coleta (aparece no /run)
var BLOCKED = [];     // contas BLOQUEADAS (status 2) que gastaram nos ult. 7 dias (p/ alerta Telegram)
var ACCT_STATUS = {}; // id da conta -> account_status atual (p/ resetar o "ja avisei" quando reativa)

/* Config das regras — padroes (iguais ao dashboard). Podem ser sobrescritos por VARIAVEIS
   do Cloudflare (R_*), pra ajustar sem mexer no codigo. Veja buildRules(env). */
var RULES = {
  dayGood: 1.6, dayOk: 1.2,
  minSpendJudge: 100, floorDaily: 85,
  cpaTarget: 175, cpaRopeGood: 190, minRoas: 1.3, cutDays: 364,
  /* PISO de ROAS p/ "ganhar" (so no ramo de ATE 5 vendas): <=2 vendas -> accBase(1.5);
     >2 vendas E dia BOM -> accGood(1.35); >2 vendas dia nao-bom -> accBase(1.5). */
  accBase: 1.5, accGood: 1.35, accGoodMinSales: 2,
  cutNoSaleSpend: 100,
  /* SEM venda hoje: ao chegar noSaleHourBR(23h) BR, baixa o DIARIO p/ noSaleDaily($100) via termino (so se estiver acima). */
  noSaleHourBR: 23, noSaleDaily: 100,
  /* SEM venda: gasto >= limSpendTrigger($90) -> LIMITAR, trava ~$120 o DIA INTEIRO (sem horario).
     A Meta forca travar em ~1,33x o gasto, entao 90 x 1,33 ~= 120 (teto real). */
  limSpendTrigger: 90, limSpendCap: 120,
  limRoas: 1.4, // COM venda: ROAS <= isso -> LIMITAR, INDEPENDENTE do nº de vendas.
  limMinSpend: 1, // SO limita por ROAS se gasto > isso. Evita o falso ROAS 0 na virada (venda sincroniza antes do gasto).
  remLimRoas: 1.5, remLimStart: 10, remLimEnd: 23, // robo REMOVE o limite sozinho se ROAS > 1,5 entre remLimStart(10h) e remLimEnd(23h) BR (campanha recuperou).
  pauseRoas: 1.5, escRoas: 1.7, escPct: 0.20, pauseSalesBreak: 3, // 1-3 vd: pausa ROAS<1,5; >3 vd: pausa ROAS<=1,3; ROAS>1,7 e 3+ vd -> +20%. Reativa: ROAS>1,5
  excRoas: 2.0, excMinSales: 3, scaleMult: 12, scaleUsePct: 0.2, releaseDaily: 500,
  aumRoasLow: 1.5, aumRoasHigh: 1.9, aumPctLow: 0.30, aumPctHigh: 0.70, aumMaxSales: 5,
  /* AUMENTAR (so SUGESTAO): so apos aumHourBR(20h) BR, ROAS de HOJE >= pauseRoas(1,5) E ROAS dos ult. 7 dias > aumRoas7dMin(1,4) -> subir o diario p/ aumMult(1,5)x o atual.
     <aumMaxSales(5) vendas: sempre. Campea (>=5): SO se nao houve aumento nos ult. aumCampeaDays(3) dias. */
  aumHourBR: 20, aumRoas7dMin: 1.4, aumMult: 1.5, aumCampeaDays: 3,
  alert3dRoas: 1.0, alert3dMinSpend: 150,
  pauseCpc: 3, pauseSpend: 60, pauseAlertMin: 50,  // CPC>$3 E 0 venda/IC E gasto>$60 -> LIMITAR GASTO (soft-stop). pauseAlertMin: min pausada -> avisa p/ reativar
  alertRepeatMin: 10,  // repete o MESMO aviso Telegram da campanha a cada X min enquanto o estado durar (antes era 1x/dia)
  cooldownMin: 5       // minutos entre 2 aplicacoes na MESMA campanha (configuravel via R_COOLDOWN). = 1 ciclo do cron
};
/* Le os parametros das variaveis do Cloudflare (se existirem), senao usa o padrao acima. */
function buildRules(env) {
  var n = function(k, d) { var v = env && env[k]; var f = parseFloat(v); return (v !== undefined && v !== '' && !isNaN(f)) ? f : d; };
  return {
    dayGood: n('R_DAYGOOD', 1.6), dayOk: n('R_DAYOK', 1.2),
    minSpendJudge: n('R_MINSPEND', 100), floorDaily: n('R_FLOOR', 85), cutDays: n('R_CUTDAYS', 364),
    cpaTarget: n('R_CPATARGET', 175), cpaRopeGood: n('R_CPAROPE', 190),
    minRoas: n('R_MINROAS', 1.3),
    accBase: n('R_ACCBASE', 1.5), accGood: n('R_ACCGOOD', 1.35), accGoodMinSales: n('R_ACCGOODMINSALES', 2),
    cutNoSaleSpend: n('R_CUTNOSALE', 100),
    noSaleHourBR: n('R_NOSALEHOUR', 23), noSaleDaily: n('R_NOSALEDAILY', 100),
    pauseRoas: n('R_PAUSEROAS', 1.5), escRoas: n('R_ESCROAS', 1.7), escPct: n('R_ESCPCT', 0.20), pauseSalesBreak: n('R_PAUSESALESBREAK', 3),
    limSpendTrigger: n('R_LIMTRIG', 90), limSpendCap: n('R_LIMCAP', 120),
    limRoas: n('R_LIMROAS', 1.4), limMinSpend: n('R_LIMMINSPEND', 1),
    remLimRoas: n('R_REMLIMROAS', 1.5), remLimStart: n('R_REMLIMSTART', 10), remLimEnd: n('R_REMLIMEND', 23),
    excRoas: n('R_EXCROAS', 2.0), excMinSales: n('R_EXCMINSALES', 3), scaleMult: n('R_SCALEMULT', 12),
    aumRoasLow: n('R_AUMROASLOW', 1.5), aumRoasHigh: n('R_AUMROASHIGH', 1.9), aumPctLow: n('R_AUMPCTLOW', 0.30), aumPctHigh: n('R_AUMPCTHIGH', 0.70), aumMaxSales: n('R_AUMMAXSALES', 5),
    aumHourBR: n('R_AUMHOURBR', 20), aumRoas7dMin: n('R_AUMROAS7D', 1.4), aumMult: n('R_AUMMULT', 1.5), aumCampeaDays: n('R_AUMCAMPEADIAS', 3),
    scaleUsePct: n('R_SCALEUSEPCT', 0.2), releaseDaily: n('R_RELEASE', 500),
    alert3dRoas: n('R_ALERT3DROAS', 1.0), alert3dMinSpend: n('R_ALERT3DSPEND', 150),
    pauseCpc: n('R_PAUSECPC', 3), pauseSpend: n('R_PAUSESPEND', 60), pauseAlertMin: n('R_PAUSEALERTMIN', 50), alertRepeatMin: n('R_ALERTREPEAT', 10),
    cooldownMin: n('R_COOLDOWN', 5)
  };
}

/* ---------- helpers de data (fuso BR fixo, UTC-3) ---------- */
/* Hora ATUAL no fuso BR (UTC-3), 0-23. Usada p/ o teto sem-venda por horario. */
function brHour() { return new Date(Date.now() - 3 * 3600 * 1000).getUTCHours(); }
function brDatePlus(days) {
  var d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
/* Cotacao USD/BRL AO VIVO (AwesomeAPI, sem chave). Fallback: R_FX (ou 5.1) se a chamada falhar. */
async function liveFx(env) {
  var fb = parseFloat(env && env.R_FX) || 5.1;
  try {
    var r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { headers: { 'Accept': 'application/json' } });
    var d = await r.json();
    var rate = (d && d.USDBRL) ? parseFloat(d.USDBRL.bid) : NaN;
    return (rate && rate > 0) ? rate : fb;
  } catch (e) { return fb; }
}
/* Envia mensagem no Telegram (se TG_TOKEN e TG_CHAT existirem). Silencioso em erro. */
async function sendTelegram(env, text) {
  try {
    if (!env.TG_TOKEN || !env.TG_CHAT) return;
    await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: text, disable_web_page_preview: true })
    });
  } catch (e) {}
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
function postForm(id, tk, params, _try) {
  _try = _try || 0;
  var body = new URLSearchParams();
  Object.keys(params).forEach(function (k) { body.append(k, params[k]); });
  body.append('access_token', tk);
  return fetch(API + '/' + id, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) {
        /* Erro transitorio do Meta ("unexpected error / retry later", code 2) -> 1 retry curto
           (1s). O cron de 5 min ja serve de retry maior; nao estouramos o tempo do Worker. */
        var msg = d.error.message || '';
        var transient = d.error.is_transient || d.error.code === 2 || /unexpected error|please (?:retry|try again)|temporar/i.test(msg);
        if (transient && _try < 1) { return new Promise(function (res) { setTimeout(res, 1000); }).then(function () { return postForm(id, tk, params, _try + 1); }); }
        throw new Error(msg + (d.error.error_user_msg ? ' - ' + d.error.error_user_msg : ''));
      }
      return d;
    });
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
  /* TESTE — fora das regras: nome com "TESTE" nunca recebe corte/escala/limite.
     target/newEnd null garante que o bloco de apply em run() (gate r.newEnd && r.key) nao aplica. */
  if ((c.name || '').toUpperCase().indexOf('TESTE') >= 0) {
    return { action: 'TESTE_FORA_DAS_REGRAS', key: 'TESTE', target: null, newEnd: null, cpa: Infinity, roas: 0, sales: c._sales || 0, spend: c._spendToday || 0 };
  }
  var sp = c._spendToday || 0, sales = c._sales || 0;
  var roas = sp > 0 ? (sales * 260) / sp : 0;
  var cpa = sales > 0 ? sp / sales : Infinity;
  var rem = remainingOf(c);
  /* CORTAR = REDUZIR RITMO: empurra o termino p/ +cutDays (364 ~ 1 ano). diario ~ saldo/364.
     Freio GENTIL (sem catch-up/dump), o oposto do antigo limite de gasto (aposentado). */
  var cortarEnd = brDatePlus(RULES.cutDays);
  var cortarTarget = rem > 0 ? (rem / RULES.cutDays) : RULES.floorDaily;
  var curDaily = currentDailyOf(c); /* ritmo diario atual: ESCALAR/AUMENTAR NUNCA pode reduzir isso */
  var clk = c._clicks || 0, ic = c._ic || 0;
  var cpc = clk > 0 ? (sp / clk) : (sp > 0 ? Infinity : 0);
  var isActive = (c.effective_status || c.status || '').toUpperCase() === 'ACTIVE';
  var target = null;
  /* PAUSADA: vendeu com ROAS > pauseRoas(1,5) -> ATIVAR (so sugestao; robo NAO auto-ativa); senao PAUSADA. */
  if (!isActive) {
    if (sales >= 1 && roas > RULES.pauseRoas) return { action: 'ATIVAR (ROAS ' + roas.toFixed(2) + ' > ' + RULES.pauseRoas + ')', key: 'ATIVAR', target: null, newEnd: null, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
    return { action: 'PAUSADA', key: 'PAUSADA', target: null, newEnd: null, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
  }
  /* LEGADO: o mecanismo de LIMITE DE GASTO foi APOSENTADO. Se ainda houver cap (era antiga) em
     qualquer campanha, o robo REMOVE o limite (qualquer hora) p/ ela voltar a rodar sob o termino. */
  if (c._hasCap) {
    return { action: 'REMOVER LIMITE (mecanismo aposentado — de volta ao termino)', key: 'REMLIMITE_AUTO', target: null, newEnd: null, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
  }
  /* AUMENTAR (so SUGESTAO — robo NAO auto-aplica): DEPOIS das aumHourBR(20h) BR, ROAS de HOJE >= pauseRoas(1,5)
     E ROAS dos ult. 7 dias > aumRoas7dMin(1,4) -> sugere subir o diario p/ aumMult(1,5)x o atual.
     <aumMaxSales(5) vendas: sempre. Campea (>=5 vendas): SO se nao houve aumento nos ult. aumCampeaDays(3) dias. */
  var _aumBase = brHour() >= RULES.aumHourBR && roas >= RULES.pauseRoas && (c._roas7d || 0) > RULES.aumRoas7dMin && sp > RULES.limMinSpend;
  var _incDays = c._lastIncDay ? Math.round((Date.parse(brDatePlus(0)) - Date.parse(c._lastIncDay)) / 86400000) : 9999;
  if (_aumBase && (sales < RULES.aumMaxSales || _incDays >= RULES.aumCampeaDays)) {
    var baseA = curDaily > 0 ? curDaily : Math.max(sp, RULES.floorDaily);
    var targetA = baseA * RULES.aumMult;
    var newEndA = (targetA && rem > 0) ? brDatePlus(Math.max(1, Math.ceil(rem / targetA))) : null;
    var _cmp = sales >= RULES.aumMaxSales ? ' campea s/ aumento ha ' + (_incDays >= 9999 ? 'nunca' : _incDays + 'd') + ',' : '';
    return { action: 'AUMENTAR diario p/ $' + Math.round(targetA) + ' (' + RULES.aumMult + 'x —' + _cmp + ' ROAS hoje ' + roas.toFixed(2) + ', 7d ' + (c._roas7d || 0).toFixed(2) + ', apos ' + RULES.aumHourBR + 'h)', key: 'AUMENTAR', target: targetA, newEnd: newEndA, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
  }
  /* SEM VENDA hoje: ao chegar noSaleHourBR(23h) BR, baixa o DIARIO p/ noSaleDaily($100) via termino
     (so se o ritmo atual estiver ACIMA de $100 — nunca aumenta). Antes das 23h: COLETANDO (da o dia p/ vender). */
  if (sales === 0) {
    if (brHour() >= RULES.noSaleHourBR && curDaily > RULES.noSaleDaily) {
      var neNS = rem > 0 ? brDatePlus(Math.max(1, Math.ceil(rem / RULES.noSaleDaily))) : cortarEnd;
      return { action: 'DIARIO p/ $' + RULES.noSaleDaily + ' (sem venda hoje, apos ' + RULES.noSaleHourBR + 'h)', key: 'CORTAR', target: RULES.noSaleDaily, newEnd: neNS, cpa: null, roas: 0, sales: 0, spend: sp };
    }
    return { action: 'COLETANDO', key: 'COLETANDO', target: null, newEnd: null, cpa: Infinity, roas: 0, sales: 0, spend: sp };
  }
  /* COM VENDA e menos de aumMaxSales(5) vendas: ROAS < limRoas(1,4) -> CORTAR (+cutDays, reduz ritmo);
     limRoas(1,4) <= ROAS < pauseRoas(1,5) -> PAUSAR (esperar o REBOTE da atribuicao 1h08; run() avisa p/ reativar antes de 1h). */
  if (sales < RULES.aumMaxSales && sp > RULES.limMinSpend) {
    if (roas < RULES.limRoas) return { action: 'REDUZIR RITMO (+' + RULES.cutDays + 'd — ROAS ' + roas.toFixed(2) + ' < ' + RULES.limRoas + ', ' + sales + ' venda)', key: 'CORTAR', target: cortarTarget, newEnd: cortarEnd, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
    if (roas < RULES.pauseRoas) return { action: 'PAUSAR — esperar rebote (ROAS ' + roas.toFixed(2) + ' < ' + RULES.pauseRoas + ', ' + sales + ' venda)', key: 'PAUSAR', target: null, newEnd: null, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
  }
  /* CAMPEA: >= aumMaxSales(5) vendas -> NUNCA corta (gestao manual, robo nao freia). Escala se ROAS alto. */
  if (sales > RULES.aumMaxSales) return { action: 'MANTER (>' + RULES.aumMaxSales + ' vendas, ROAS ' + roas.toFixed(2) + ' — gestao manual)', key: 'MANTER', target: null, newEnd: null, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
  /* ROAS >= 1,5 mas fora da janela AUMENTAR (antes das 20h, ou 7d <= 1,4): MANTER (nao mexe). */
  return { action: 'MANTER (ROAS ' + roas.toFixed(2) + ', mantem orcamento)', key: 'MANTER', target: null, newEnd: null, cpa: isFinite(cpa) ? cpa : null, roas: roas, sales: sales, spend: sp };
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

/* Busca os CONJUNTOS (ad sets) de cada campanha em LOTE (Batch API): id, status e limite atual
   (lifetime_spend_cap). Popula c._adsets e c._hasCap (>=1 conjunto com limite = campanha ja limitada). */
async function batchAdsetCaps(camps) {
  var byTk = {};
  camps.forEach(function (c) { c._adsets = []; c._hasCap = false; (byTk[c._tk] = byTk[c._tk] || []).push(c); });
  for (var tk in byTk) {
    var list = byTk[tk];
    for (var i = 0; i < list.length; i += 50) {
      var chunk = list.slice(i, i + 50);
      var batch = chunk.map(function (c) { return { method: 'GET', relative_url: c.id + '/adsets?fields=id,effective_status,lifetime_spend_cap&limit=50' }; });
      var body = new URLSearchParams();
      body.append('batch', JSON.stringify(batch));
      body.append('access_token', tk);
      try {
        var resp = await fetch(API + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        var arr = await resp.json();
        if (Array.isArray(arr)) {
          arr.forEach(function (item, idx) {
            var c = chunk[idx];
            try {
              var b = JSON.parse(item.body); var sets = b.data || [];
              c._adsets = sets;
              /* LIMITADA? Teste pelo GASTO, nao pelo orcamento: um teto so LIMITA se estiver perto do que a
                 campanha ja gastou (o robo trava em ~1,33x). Teto muito acima do gasto nao trava nada. */
              var sumCaps = 0, anyCap = false;
              sets.forEach(function (s) {
                var cap = (s.lifetime_spend_cap != null) ? +s.lifetime_spend_cap : 0;
                if (cap > 0) { anyCap = true; sumCaps += cap / 100; }
              });
              c._hasCap = anyCap && sumCaps < Math.max((c._spend || 0) * 2, 20);
            } catch (e) { c._adsets = []; c._hasCap = false; }
          });
        }
      } catch (e) {}
    }
  }
}

/* VIRADA DO DIA: remove o limite de gasto de TODAS as campanhas limitadas (setando o cap dos conjuntos
   = orcamento vitalicio da campanha = sem limite na pratica), p/ rodarem de novo no dia novo. Em LOTE
   (Batch API, POST) p/ nao estourar subrequests. Devolve quantos conjuntos foram liberados. */
async function removeCapsForNewDay(camps) {
  var byTk = {}, count = 0;
  camps.forEach(function (c) {
    if (!c._hasCap) return;
    var lb = parseInt(c.lifetime_budget) || 0;
    if (lb <= 0) return; /* sem orcamento vitalicio: nao mexe */
    (c._adsets || []).forEach(function (s) {
      var cap = (s.lifetime_spend_cap != null) ? +s.lifetime_spend_cap : 0;
      if (cap > 0) { (byTk[c._tk] = byTk[c._tk] || []).push({ id: s.id, val: lb }); }
    });
  });
  for (var tk in byTk) {
    var ops = byTk[tk];
    for (var i = 0; i < ops.length; i += 50) {
      var chunk = ops.slice(i, i + 50);
      var batch = chunk.map(function (o) { return { method: 'POST', relative_url: String(o.id), body: 'lifetime_spend_cap=' + o.val }; });
      try {
        var body = new URLSearchParams();
        body.append('batch', JSON.stringify(batch));
        body.append('access_token', tk);
        await fetch(API + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        count += chunk.length;
      } catch (e) {}
    }
  }
  /* marca em memoria como nao-limitadas p/ rodarem normal ja neste ciclo */
  camps.forEach(function (c) { if (c._hasCap) c._hasCap = false; });
  return count;
}

/* ---------- coleta dados (Meta + RedTrack) ---------- */
async function collect(env) {
  var tokens = JSON.parse(env.META_TOKENS || '[]');
  var map = {};
  for (var ti = 0; ti < tokens.length; ti++) {
    var list = await fjPaged(API + '/me/adaccounts?fields=name,account_status&limit=100&access_token=' + tokens[ti]);
    list.forEach(function (a) { var id = a.id.replace('act_', ''); if (!map[id]) { map[id] = a; map[id]._tk = tokens[ti]; } });
  }
  /* Mapa de status atual (p/ resetar o "ja avisei" quando a conta volta a ativa). */
  ACCT_STATUS = {}; Object.keys(map).forEach(function (id) { ACCT_STATUS[id] = map[id].account_status; });
  /* CONTAS BLOQUEADAS (account_status 2 = DISABLED) que GASTARAM nos ultimos 7 dias.
     Gasto 7d em LOTE (Batch API) p/ nao estourar subrequests (pode haver dezenas de contas status 2). */
  BLOCKED = [];
  var blk = Object.values(map).filter(function (a) { return a.account_status === 2; });
  var byTkB = {}; blk.forEach(function (a) { (byTkB[a._tk] = byTkB[a._tk] || []).push(a); });
  for (var tkB in byTkB) {
    var listB = byTkB[tkB];
    for (var iB = 0; iB < listB.length; iB += 50) {
      var chunkB = listB.slice(iB, iB + 50);
      var batchB = chunkB.map(function (a) { return { method: 'GET', relative_url: a.id + '/insights?fields=spend&date_preset=last_7d&level=account' }; });
      try {
        var bodyB = new URLSearchParams(); bodyB.append('batch', JSON.stringify(batchB)); bodyB.append('access_token', tkB);
        var respB = await fetch(API + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bodyB.toString() });
        var arrB = await respB.json();
        if (Array.isArray(arrB)) arrB.forEach(function (item, idx) {
          var a = chunkB[idx], sp7 = 0;
          try { var bb = JSON.parse(item.body); sp7 = (bb.data && bb.data[0]) ? parseFloat(bb.data[0].spend) || 0 : 0; } catch (e) {}
          if (sp7 > 0) BLOCKED.push({ id: a.id.replace('act_', ''), name: a.name || a.id, spend7d: Math.round(sp7) });
        });
      } catch (e) {}
    }
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
  /* Conjuntos + limite de gasto atual (p/ regra LIMITAR/REMOVER e detectar campanha ja limitada). */
  await batchAdsetCaps(camps);

  // Cambio USD/BRL AO VIVO (AwesomeAPI); fallback R_FX. Converte o custo do RedTrack (R$) em US$.
  var fx = await liveFx(env);
  // vendas de hoje (RedTrack, por sub3 = campaign_id)
  DIAG = { rtTokenSet: !!env.RT_TOKEN, metaTokens: JSON.parse(env.META_TOKENS || '[]').length, today: brDatePlus(0), fx: fx, camps: camps.length };
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
    /* fx (cambio ao vivo) ja definido no inicio da collect. */
    var pickNum = function(o, ks){ for (var i=0;i<ks.length;i++){ var v=o[ks[i]]; if (v!=null && v!=='' && !isNaN(parseFloat(v))) return parseFloat(v); } return 0; };
    var icType = env.RT_ICTYPE || '2';
    var by = {}, byCost = {}, byClicks = {}, byIC = {};
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (row.sub3 != null) {
        /* Vendas = convtype{N}; se 0, cai pra 'approved' (algumas contas usam esse campo). */
        var s = parseInt(row['convtype' + pType]) || 0;
        if (!s) s = parseInt(row.approved) || 0;
        by[String(row.sub3)] = s;
        byCost[String(row.sub3)] = pickNum(row, ['cost','total_cost','spend','ad_cost']);
        byClicks[String(row.sub3)] = pickNum(row, ['clicks']);
        byIC[String(row.sub3)] = parseInt(row['convtype' + icType]) || 0;
      }
    });
    camps.forEach(function (c) {
      c._sales = by[String(c.id)] || 0;
      c._clicks = byClicks[String(c.id)] || 0;
      c._ic = byIC[String(c.id)] || 0;
      /* GASTO pelo RedTrack (R$ -> US$), mesma fonte/fuso das vendas. Senao, mantem o do Meta. */
      var rc = byCost[String(c.id)] || 0;
      if (rc > 0) c._spendToday = rc / fx;
    });
  } else {
    camps.forEach(function (c) { c._sales = 0; c._clicks = 0; c._ic = 0; });
  }
  /* ROAS dos ULTIMOS 7 DIAS por campanha (RedTrack group=sub3) — so p/ a sugestao AUMENTAR (apos 20h). */
  camps.forEach(function (c) { c._roas7d = 0; });
  if (env.RT_TOKEN) {
    try {
      var pType7 = env.RT_PTYPE || '1';
      var url7 = RT_API + '/report?api_key=' + encodeURIComponent(env.RT_TOKEN) + '&group=sub3&date_from=' + brDatePlus(-6) + '&date_to=' + brDatePlus(0) + '&per=1000';
      var resp7 = await fetch(url7, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; CBORobo/1.0)' } });
      var d7 = await resp7.json();
      var rows7 = d7.items || d7.data || d7.report || (Array.isArray(d7) ? d7 : []);
      var by7 = {};
      (Array.isArray(rows7) ? rows7 : []).forEach(function (row) {
        if (row.sub3 == null) return;
        var s7 = parseInt(row['convtype' + pType7]) || parseInt(row.approved) || 0;
        var cst7 = 0; ['cost', 'total_cost', 'spend', 'ad_cost'].forEach(function (k) { if (!cst7 && row[k] != null && row[k] !== '') cst7 = parseFloat(row[k]) || 0; });
        by7[String(row.sub3)] = { s: s7, cost: cst7 };
      });
      camps.forEach(function (c) {
        var v = by7[String(c.id)];
        if (v && v.cost > 0) { var spU = v.cost / fx; c._roas7d = spU > 0 ? (v.s * 260) / spU : 0; }
      });
      DIAG.rt7dRows = Array.isArray(rows7) ? rows7.length : 0;
    } catch (e) { DIAG.rt7dErr = String((e && e.message) || e); }
  }
  return camps;
}

/* ---------- aplicar (só em APPLY_MODE=live) ---------- */
async function applyChange(c, tokens, newEnd) {
  var endIso = newEnd + 'T23:59:00-03:00';
  var endTs = Math.floor(new Date(endIso).getTime() / 1000);
  /* So o stop_time muda o ritmo da CBO; NAO reenviamos lifetime_budget (redundante e gatilho de erro). */
  var campParams = { stop_time: String(endTs) };
  await withTokenFallback(tokens, c._tk, function (tk) { return postForm(c.id, tk, campParams); }).catch(function () {});
  var setsR = await withTokenFallback(tokens, c._tk, function (tk) { return fj(API + '/' + c.id + '/adsets?fields=id&limit=200&access_token=' + tk).then(function (r) { if (r.error) throw new Error(r.error.message); return r; }); }).catch(function () { return { result: {} }; });
  var sets = (setsR.result && setsR.result.data) || [];
  for (var i = 0; i < sets.length; i++) {
    await withTokenFallback(tokens, c._tk, function (tk) { return postForm(sets[i].id, tk, { end_time: endIso }); }).catch(function () {});
  }
}

/* Aplica LIMITE DE GASTO (lifetime_spend_cap) nos conjuntos ATIVOS = soft-stop (NAO pausa, nao reseta aprendizado).
   folga = limCap - gasto de hoje, dividida entre os conjuntos; cada conjunto: gasto vitalicio DELE + fatia.
   Soma dos caps = gasto vitalicio da campanha + folga -> campanha nao passa de ~limCap hoje.
   Cada cap >= gasto do proprio conjunto (senao o Facebook REJEITA). Valores em CENTAVOS. */
async function applySpendCap(c, tokens, todaySpend, limCap) {
  var active = (c._adsets || []).filter(function (s) { return (s.effective_status || '').toUpperCase() === 'ACTIVE'; });
  if (!active.length) return false;
  /* gasto vitalicio POR conjunto (fresco, Batch API) — o Facebook exige cap >= isso. */
  var sinceLife = new Date(); sinceLife.setMonth(sinceLife.getMonth() - 36);
  var lifeRange = encodeURIComponent(JSON.stringify({ since: sinceLife.toISOString().split('T')[0], until: brDatePlus(0) }));
  var batch = active.map(function (s) { return { method: 'GET', relative_url: s.id + '/insights?fields=spend&time_range=' + lifeRange }; });
  var byLife = {};
  try {
    var r = await withTokenFallback(tokens, c._tk, function (tk) {
      var b = new URLSearchParams(); b.append('batch', JSON.stringify(batch)); b.append('access_token', tk);
      return fetch(API + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() }).then(function (x) { return x.json(); });
    });
    var arr = r.result;
    if (!Array.isArray(arr)) return false;
    arr.forEach(function (item, idx) { try { var bb = JSON.parse(item.body); byLife[active[idx].id] = (bb.data && bb.data[0]) ? parseFloat(bb.data[0].spend) || 0 : 0; } catch (e) { byLife[active[idx].id] = 0; } });
  } catch (e) { return false; }
  var headroom = Math.max(0, limCap - todaySpend);
  var share = headroom / active.length;
  var okAny = false;
  for (var i = 0; i < active.length; i++) {
    var life = byLife[active[i].id] || 0;
    var capCents = Math.round(life * 100) + Math.max(1, Math.round(share * 100)); /* >= gasto do conjunto + fatia da folga */
    var adId = active[i].id;
    /* Aplica no conjunto usando SO o token da campanha. Se recusar por estar abaixo do minimo,
       LE o minimo da msg e repete com ele (com margem) — ate 3x (o minimo sobe conforme o gasto cresce). */
    var okThis = false, capV = capCents, measured = false;
    for (var t = 0; t < 4 && !okThis; t++) {
      try {
        await postForm(adId, c._tk, { lifetime_spend_cap: capV });
        okThis = true; okAny = true;
      } catch (eC) {
        var mn = metaMinCapCents(eC && eC.message);
        if (!measured && mn) { /* MEDICAO 1x por conjunto: gasto -> minimo (confirmar fator no /run). */
          try { DIAG.capMins = DIAG.capMins || []; if (DIAG.capMins.length < 20) DIAG.capMins.push({ ad: adId, gasto: +life.toFixed(2), min: +(mn / 100).toFixed(2), fator: life > 0 ? +((mn / 100) / life).toFixed(3) : null }); } catch (e3) {}
          measured = true;
        }
        if (mn && mn > capV) { capV = mn; continue; } /* tenta de novo com o minimo (+margem ja embutida) */
        break; /* erro que nao e "minimo" -> desiste desse conjunto */
      }
    }
  }
  return okAny;
}

/* Le o MINIMO que o Facebook exige quando recusa um lifetime_spend_cap baixo
   ("...deve ser de pelo menos US$92,92") -> centavos com MARGEM (+3% e +$1), pois o gasto cresce
   entre ler e aplicar. pt-BR e en. 0 se nao achar. */
function metaMinCapCents(msg) {
  msg = String(msg || '');
  var m = msg.match(/pelo menos[^\d]*([\d.,]+)/i) || msg.match(/at least[^\d]*([\d.,]+)/i) || msg.match(/US?\$\s*([\d.,]+)/);
  if (!m) return 0;
  var num = m[1];
  if (num.indexOf(',') >= 0) num = num.replace(/\./g, '').replace(',', '.');
  var v = parseFloat(num);
  if (!isFinite(v) || v <= 0) return 0;
  return Math.ceil(v * 100 * 1.03) + 100;
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
  /* Ultimo AUMENTO por campanha (do historico) — p/ a regra: campea so recebe AUMENTAR se nao aumentou
     nos ult. aumCampeaDays dias. Aumento = sig AUMENTAR ou entrada com dailyNew > dailyOld. */
  var lastIncByCamp = {};
  histLog.forEach(function (e) {
    if (!e || !e.day) return;
    var isInc = e.sig === 'AUMENTAR' || (typeof e.dailyNew === 'number' && typeof e.dailyOld === 'number' && e.dailyNew > e.dailyOld);
    if (!isInc) return;
    var id = String(e.id);
    if (!lastIncByCamp[id] || e.day > lastIncByCamp[id]) lastIncByCamp[id] = e.day;
  });
  camps.forEach(function (c) { c._lastIncDay = lastIncByCamp[String(c.id)] || null; });
  var appliedDirty = false, today = brDatePlus(0);
  /* VIRADA DO DIA: no 1o ciclo de um DIA NOVO, remove o limite de gasto de TODAS as limitadas p/ rodarem
     de novo (ciclo diario). 1x por dia (KV capResetDay). Depois seguem as regras normais neste mesmo ciclo. */
  var capReset = null; try { capReset = await env.RULES_KV.get('capResetDay'); } catch (e) {}
  if (capReset !== today) {
    var toClear = camps.filter(function (c) { return c._hasCap; });
    DIAG.capReset = { day: today, limitadas: toClear.length, mode: env.APPLY_MODE || 'dry' };
    if ((env.APPLY_MODE || 'dry') === 'live') {
      if (toClear.length) { DIAG.capReset.conjuntosLiberados = await removeCapsForNewDay(toClear); }
      try { await env.RULES_KV.put('capResetDay', today); } catch (e) {}
    }
  }
  var actions = [];
  var pausedList = []; /* campanhas pausadas neste ciclo (p/ alerta Telegram) */
  var limitedList = []; /* campanhas que receberam LIMITE DE GASTO neste ciclo (p/ alerta Telegram) */
  var reactList = [];  /* pausadas ha ~pauseAlertMin min (ROAS>1,3) -> aviso Telegram p/ reativar antes de 1h */
  var unlimitedList = []; /* limite REMOVIDO pelo robo (recuperou ROAS>1,5 na janela) -> aviso Telegram */
  var cortadaList = []; /* campanhas com RITMO REDUZIDO (termino +cutDays) neste ciclo -> aviso Telegram */
  /* Momento em que o robo pausou cada campanha (KV) -> base do aviso "reative antes de 1h". */
  var pausedAt = {}; try { var pa = await env.RULES_KV.get('pausedAt'); if (pa) { var pj = JSON.parse(pa); if (pj && typeof pj === 'object') pausedAt = pj; } } catch (e) {}
  var pausedAtDirty = false;
  for (var i = 0; i < camps.length; i++) {
    var c = camps[i];
    var r = suggestRule(c, moodObj.mood);
    actions.push({ name: c.name, id: c.id, action: r.action, target: r.target, newEnd: r.newEnd, sales: r.sales, spend: Math.round(r.spend), cpa: isFinite(r.cpa) ? Math.round(r.cpa) : null, roas: +r.roas.toFixed(2) });

    /* ── PAUSAR: status PAUSED. Registra em pausedList (dry E live, p/ Telegram). So pausa de verdade em live e se ativa. ── */
    if (r.key === 'PAUSAR') {
      pausedList.push({ id: c.id, name: c.name, action: r.action });
      if ((env.APPLY_MODE || 'dry') === 'live' && (c.effective_status || c.status || '').toUpperCase() === 'ACTIVE') {
        try {
          await withTokenFallback(tokens, c._tk, function (tk) { return postForm(c.id, tk, { status: 'PAUSED' }); });
          pausedAt[c.id] = Date.now(); pausedAtDirty = true; /* base do aviso "reative antes de 1h" */
          histLog.unshift({ id: c.id, name: c.name, t: Date.now(), day: today, sig: 'PAUSAR', action: r.action, roas: +r.roas.toFixed(2), sales: r.sales, spend: Math.round(r.spend), dailyNew: null, endNew: null, source: 'robo', tkId: (c._tk ? String(c._tk).slice(-6) : '') });
          if (histLog.length > 500) histLog = histLog.slice(0, 500);
          histDirty = true;
        } catch (e) {}
      }
    } else if (r.key === 'REMLIMITE_AUTO') {
      /* ── RECUPEROU (ROAS>remLimRoas, janela remLimStart..remLimEnd): robo REMOVE o limite sozinho. ── */
      unlimitedList.push({ id: c.id, name: c.name, roas: +r.roas.toFixed(2) });
      if ((env.APPLY_MODE || 'dry') === 'live' && (c.effective_status || c.status || '').toUpperCase() === 'ACTIVE') {
        try {
          await removeCapsForNewDay([c]); /* seta cap = orcamento da campanha (= sem limite) e marca _hasCap=false */
          appliedMap[c.id] = { sig: 'REMLIMITE_AUTO', action: r.action, t: Date.now(), day: today };
          appliedDirty = true;
          histLog.unshift({ id: c.id, name: c.name, t: Date.now(), day: today, sig: 'REMLIMITE_AUTO', action: r.action, roas: +r.roas.toFixed(2), sales: r.sales, spend: Math.round(r.spend), dailyNew: null, endNew: null, source: 'robo', tkId: (c._tk ? String(c._tk).slice(-6) : '') });
          if (histLog.length > 500) histLog = histLog.slice(0, 500);
          histDirty = true;
        } catch (e) {}
      }
    } else if (r.key === 'LIMITAR_GASTO') {
      /* ── LIMITAR GASTO (soft-stop): aplica lifetime_spend_cap nos conjuntos (live, campanha ativa,
         respeitando cooldown). NAO pausa. REMLIMITE fica de fora (remocao SO manual / virada). ── */
      limitedList.push({ id: c.id, name: c.name, action: r.action });
      if ((env.APPLY_MODE || 'dry') === 'live' && (c.effective_status || c.status || '').toUpperCase() === 'ACTIVE') {
        var prevL = appliedMap[c.id];
        var sameL = prevL && prevL.day === today && prevL.sig === r.key; /* nao repete a MESMA acao no mesmo dia */
        var ckL = 'cd:' + c.id, lastL = 0;
        try { lastL = parseInt(await env.RULES_KV.get(ckL)) || 0; } catch (e) {}
        if (!sameL && (Date.now() - lastL >= RULES.cooldownMin * 60 * 1000)) {
          /* target = teto alvo: sem venda -> limSpendCap($100); ROAS<=1,4/CPC -> gasto de hoje. */
          var okL = await applySpendCap(c, tokens, r.spend, (typeof r.target === 'number' && r.target > 0) ? r.target : RULES.limSpendCap);
          if (okL) {
            try { await env.RULES_KV.put(ckL, String(Date.now())); } catch (e) {}
            appliedMap[c.id] = { sig: r.key, action: r.action, t: Date.now(), day: today };
            appliedDirty = true;
            histLog.unshift({ id: c.id, name: c.name, t: Date.now(), day: today, sig: r.key, action: r.action, roas: +r.roas.toFixed(2), sales: r.sales, spend: Math.round(r.spend), dailyOld: null, dailyNew: null, endOld: null, endNew: null, source: 'robo', tkId: (c._tk ? String(c._tk).slice(-6) : '') });
            if (histLog.length > 500) histLog = histLog.slice(0, 500);
            histDirty = true;
          }
        }
      }
    } else if ((env.APPLY_MODE || 'dry') === 'live' && r.newEnd && r.key && r.key !== 'AUMENTAR') {
      /* AUMENTAR fica de FORA do auto-apply (usuario faz manual pelo dashboard). O robo so sugere. */
      var prev = appliedMap[c.id];
      var sameAsLast = prev && prev.day === today && prev.sig === r.key; // a ULTIMA aplicada hoje ja foi essa mesma regra -> nao repete (mas reaplica se mudou e voltou)
      var ck = 'cd:' + c.id, last = 0;
      try { last = parseInt(await env.RULES_KV.get(ck)) || 0; } catch (e) {}
      if (!sameAsLast && (Date.now() - last >= RULES.cooldownMin * 60 * 1000)) {
        await applyChange(c, tokens, r.newEnd);
        try { await env.RULES_KV.put(ck, String(Date.now())); } catch (e) {}
        appliedMap[c.id] = { sig: r.key, action: r.action, t: Date.now(), day: today };
        appliedDirty = true;
        /* ANTES da mudanca: ritmo diario atual e termino atual, p/ o dashboard mostrar "anterior -> novo". */
        var dOld = currentDailyOf(c);
        var eOld = null;
        try { if (c.stop_time) { var _so = (typeof c.stop_time === 'number') ? new Date(c.stop_time * 1000) : new Date(c.stop_time); eOld = _so.toISOString().split('T')[0]; } } catch (e) {}
        /* Append RICO no historico do robo (cap 500, mais novo no topo). */
        histLog.unshift({
          id: c.id, name: c.name, t: Date.now(), day: today,
          sig: r.key, action: r.action,
          roas: +r.roas.toFixed(2), sales: r.sales, spend: Math.round(r.spend),
          dailyOld: dOld > 0 ? Math.round(dOld) : null, dailyNew: r.target != null ? Math.round(r.target) : null,
          endOld: eOld, endNew: r.newEnd,
          source: 'robo',
          tkId: (c._tk ? String(c._tk).slice(-6) : '') /* id CURTO do token p/ filtro por estrutura no dashboard */
        });
        if (histLog.length > 500) histLog = histLog.slice(0, 500);
        if (r.key === 'CORTAR') cortadaList.push({ id: c.id, name: c.name, action: r.action });
        histDirty = true;
      }
    }
    /* Rastreio de PAUSA p/ o aviso de reativar ANTES de 1h: campanha ativa -> limpa o registro;
       pausada ha >= pauseAlertMin(50) min (janela de 20 min) e ROAS>minRoas(1,3) -> entra no aviso. */
    var isActiveC = (c.effective_status || c.status || '').toUpperCase() === 'ACTIVE';
    if (isActiveC) { if (pausedAt[c.id]) { delete pausedAt[c.id]; pausedAtDirty = true; } }
    else if (pausedAt[c.id]) {
      var elapP = Date.now() - pausedAt[c.id];
      if (elapP >= RULES.pauseAlertMin * 60000 && r.roas > RULES.minRoas) {
        reactList.push({ id: c.id, name: c.name, mins: Math.round(elapP / 60000), roas: +r.roas.toFixed(2) });
      }
    }
  }
  if (appliedDirty) { try { await env.RULES_KV.put('applied', JSON.stringify(appliedMap)); } catch (e) {} }
  if (histDirty) { try { await env.RULES_KV.put('histLog', JSON.stringify(histLog)); } catch (e) {} }
  if (pausedAtDirty) {
    var cutPa = Date.now() - (RULES.pauseAlertMin + 60) * 60000; /* poda registros antigos */
    var cleanPa = {}; Object.keys(pausedAt).forEach(function (k) { if (pausedAt[k] >= cutPa) cleanPa[k] = pausedAt[k]; });
    try { await env.RULES_KV.put('pausedAt', JSON.stringify(cleanPa)); } catch (e) {}
  }

  /* ── TELEGRAM: avisos das campanhas. Anti-spam por TIMESTAMP: repete o MESMO aviso a cada
     alertRepeatMin(10) min enquanto o estado durar (antes era 1x/dia). ── */
  if (env.TG_TOKEN && env.TG_CHAT) {
    try {
      var repMs = (RULES.alertRepeatMin || 10) * 60000, nowT = Date.now();
      /* tgSent = { chave: timestamp do ultimo envio }. Poda: descarta chaves com > 26h. */
      var sent = {}; try { var ss = await env.RULES_KV.get('tgSent'); if (ss) { var sj = JSON.parse(ss); if (sj && typeof sj === 'object') sent = sj; } } catch (e) {}
      var newSent = {}; Object.keys(sent).forEach(function (k) { if (typeof sent[k] === 'number' && (nowT - sent[k]) < 26 * 3600000) newSent[k] = sent[k]; });
      var canSend = function (k) { return !newSent[k] || (nowT - newSent[k]) >= repMs; };
      var liveMode = (env.APPLY_MODE || 'dry') === 'live';
      var lines = [];
      for (var pi = 0; pi < pausedList.length; pi++) {
        var pp = pausedList[pi];
        var pk = pp.id + ':pause';
        if (canSend(pk)) { lines.push('• ' + pp.name + '\n   ' + pp.action); newSent[pk] = nowT; }
      }
      if (lines.length) {
        var show = lines.slice(0, 25);
        if (lines.length > 25) show.push('…e mais ' + (lines.length - 25) + ' campanha(s).');
        var head = liveMode ? '\u{1F6D1} Robô PAUSOU ' : '⚠️ Robô PAUSARIA (dry, não pausou) ';
        await sendTelegram(env, head + lines.length + ' campanha(s):\n\n' + show.join('\n\n'));
      }
      /* LIMITE DE GASTO (soft-stop sem venda). */
      var linesL = [];
      for (var li = 0; li < limitedList.length; li++) {
        var ll = limitedList[li];
        var lk = ll.id + ':limit';
        if (canSend(lk)) { linesL.push('• ' + ll.name + '\n   ' + ll.action); newSent[lk] = nowT; }
      }
      if (linesL.length) {
        var showL = linesL.slice(0, 25);
        if (linesL.length > 25) showL.push('…e mais ' + (linesL.length - 25) + ' campanha(s).');
        var headL = liveMode ? '\u{1F6A7} Robô LIMITOU o gasto de ' : '⚠️ Robô LIMITARIA o gasto (dry) de ';
        await sendTelegram(env, headL + linesL.length + ' campanha(s):\n\n' + showL.join('\n\n'));
      }
      /* RITMO REDUZIDO (termino +cutDays): freio GENTIL, sem catch-up/dump. */
      var linesC = [];
      for (var ci = 0; ci < cortadaList.length; ci++) {
        var cc = cortadaList[ci];
        var ckC = cc.id + ':cortar';
        if (canSend(ckC)) { linesC.push('• ' + cc.name + '\n   ' + cc.action); newSent[ckC] = nowT; }
      }
      if (linesC.length) {
        var showC = linesC.slice(0, 25);
        if (linesC.length > 25) showC.push('…e mais ' + (linesC.length - 25) + ' campanha(s).');
        await sendTelegram(env, '\u{2702}\u{FE0F} Robô REDUZIU o ritmo (término +' + RULES.cutDays + 'd) de ' + linesC.length + ' campanha(s):\n\n' + showC.join('\n\n'));
      }
      /* LIMITE REMOVIDO pelo robo (recuperou ROAS>1,5 na janela). */
      var linesU = [];
      for (var ui = 0; ui < unlimitedList.length; ui++) {
        var uu = unlimitedList[ui];
        var uk = uu.id + ':unlim';
        if (canSend(uk)) { linesU.push('• ' + uu.name + '\n   recuperou · ROAS ' + uu.roas.toFixed(2) + ' — limite REMOVIDO, voltou a rodar'); newSent[uk] = nowT; }
      }
      if (linesU.length) {
        var showU = linesU.slice(0, 25);
        if (linesU.length > 25) showU.push('…e mais ' + (linesU.length - 25) + ' campanha(s).');
        var headU = liveMode ? '\u{2705} Robô REMOVEU o limite de ' : '⚠️ Robô REMOVERIA o limite (dry) de ';
        await sendTelegram(env, headU + linesU.length + ' campanha(s) que recuperou (ROAS>' + RULES.remLimRoas + '):\n\n' + showU.join('\n\n'));
      }
      /* REATIVAR: pausadas ha >= pauseAlertMin min (ROAS>1,3), repete a cada alertRepeatMin ate reativar. */
      var linesR = [];
      for (var ri = 0; ri < reactList.length; ri++) {
        var rr = reactList[ri];
        var rk = rr.id + ':react';
        if (canSend(rk)) { linesR.push('• ' + rr.name + '\n   pausada ha ~' + rr.mins + ' min · ROAS ' + rr.roas.toFixed(2) + ' — REATIVE antes de 1h'); newSent[rk] = nowT; }
      }
      if (linesR.length) {
        var showR = linesR.slice(0, 25);
        if (linesR.length > 25) showR.push('…e mais ' + (linesR.length - 25) + ' campanha(s).');
        await sendTelegram(env, '⏰ REATIVAR ' + linesR.length + ' campanha(s) pausada(s) ha ~' + RULES.pauseAlertMin + ' min:\n\n' + showR.join('\n\n'));
      }
      try { await env.RULES_KV.put('tgSent', JSON.stringify(newSent)); } catch (e) {}

      /* CONTA BLOQUEADA (status 2) que gastou nos ult. 7 dias -> avisa 1x SO (ate a conta voltar a ativa).
         Anti-spam separado do tgSent (nao e por dia): KV 'blockedNotified' = { id: true }. */
      var bNotif = {}; try { var bs = await env.RULES_KV.get('blockedNotified'); if (bs) { var bj = JSON.parse(bs); if (bj && typeof bj === 'object') bNotif = bj; } } catch (e) {}
      var bDirty = false;
      /* reseta o "ja avisei" das contas que voltaram a ATIVA (status 1) -> se bloquear de novo, avisa de novo. */
      Object.keys(bNotif).forEach(function (id) { if (ACCT_STATUS[id] === 1) { delete bNotif[id]; bDirty = true; } });
      var linesB = [];
      for (var bi = 0; bi < BLOCKED.length; bi++) {
        var ba = BLOCKED[bi];
        if (!bNotif[ba.id]) { linesB.push('• ' + ba.name + '\n   gastou $' + ba.spend7d + ' nos ult. 7 dias'); bNotif[ba.id] = today; bDirty = true; }
      }
      if (linesB.length) {
        var showB = linesB.slice(0, 25);
        if (linesB.length > 25) showB.push('…e mais ' + (linesB.length - 25) + ' conta(s).');
        await sendTelegram(env, '\u{1F6AB} CONTA BLOQUEADA — ' + linesB.length + ' conta(s) que estava(m) gastando:\n\n' + showB.join('\n\n'));
      }
      if (bDirty) { try { await env.RULES_KV.put('blockedNotified', JSON.stringify(bNotif)); } catch (e) {} }
    } catch (e) { DIAG.tgErr = String((e && e.message) || e); }
  }
  DIAG.blocked = BLOCKED.length; /* visivel no /run */

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
