/* ============================================================
   Sound — звук на сэмплах (ТЗ №55; до него — синтез на осцилляторах).

   Что звучит и как — assets/audio/manifest.json (событие → варианты →
   файлы → группа → громкость, разброс, лимиты). В сборке build.py кладёт
   рядом только активный вариант каждого события (папка audio/) и
   подменяет AUDIO_BASE ниже.

   * Загрузка — фоном после init(): манифест, затем файлы (по 4 разом,
     частые события первыми). Декодирование в OfflineAudioContext — до
     первого жеста, без предупреждения автоплея и без ожидания игрока;
     первая отрисовка и gameReady звук не ждут.
   * Формат — Ogg Opus, если браузер его заявляет (canPlayType), иначе MP3;
     не декодировался ogg — повтор с mp3; не вышло и так — одно
     console.warn на файл, событие молчит, игра продолжает.
   * Разблокировка — первый жест (pointerup/touchend/mousedown/click/
     keydown): создаётся AudioContext, resume() и пустой буфер в 1 отсчёт
     (ключ зажигания iOS WKWebView). Слушатели остаются: после звонка iOS
     переводит контекст в interrupted, и его снова будит жест.
   * Полифония — каждый вызов = свой источник; maxInstances на событие
     (лишний голос — самый старый, гаснет за 15 мс), minGapMs — не чаще,
     общий потолок MAX_VOICES; разброс высоты/громкости pitchVar/volVar;
     дубли одного события — без повтора подряд.
   * Комбо линий (ТЗ №54): закрытия в окне combo.windowMs поднимаются по
     ступеням combo.steps (полутоны D5-E5-G5-A5-B5-D6), пауза сбрасывает на
     первую; вариант mode:'steps' — своя запись на каждую ступень, 'rate' —
     одна запись с playbackRate 2^(n/12). Две линии одним ходом звучат
     «перекатом» через combo.rollMs, а не аккордом.
   * cancels/queueAfter: победа гасит ноту линии того же хода; открытка
     главы и «глава открыта» ждут конца мелодии победы. Ушёл игрок с
     экрана победы раньше — cancelPending() снимает ещё не начавшиеся.
   * Дубли — только из загруженных файлов: сбойный дубль не глушит
     каждый N-й ход.
   * Шины: master → sfx, ui. Громкость шин — localStorage (настройка
     устройства, без UI; сейв игры не трогается), mute — поле сейва muted,
     его ставит main.js через setMuted().
   * Пауза: suspend()/resume() — реклама (п.4.7), сворачивание страницы —
     своя причина (п.1.3). Звук вернётся, только когда сняты обе: ролик
     идёт, а страницу свернули и развернули — тишина до конца ролика;
     ролик кончился в свёрнутой — контекст ждёт возврата на страницу.
   ============================================================ */

window.Sound = (function () {
  // build.py: в сборке звук лежит в audio/ (не в assets/).
  var AUDIO_BASE = 'audio/';
  var SETTINGS_KEY = 'nonogram_audio_v1';
  var MAX_VOICES = 24;
  var LOAD_CONCURRENCY = 4;
  var LEAD_SKIP_THR = 0.001;   // −60 dBFS: почти-тишина в начале буфера
  var LEAD_SKIP_MAX_S = 0.06;
  var STEAL_FADE_S = 0.015;
  var PRELOAD_FIRST = ['cellFill', 'cellCross', 'cellErase', 'uiTap', 'uiBack', 'uiToggle', 'lineClosed', 'win'];
  var CELL_EVENTS = { fill: 'cellFill', cross: 'cellCross', erase: 'cellErase', hint: 'hint', reveal: 'checkFixed' };

  // ?v= этого скрипта — тот же штамп сборки, что у остальных файлов.
  var VER = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      var m = s && /[?&]v=([^&#]+)/.exec(s);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();

  var manifest = null;
  var ctx = null;
  var decodeCtx = null;
  var master = null;
  var buses = {};
  var volumes = { master: 1, sfx: 1, ui: 1 };
  var userVolumes = {};
  var muted = false;
  // Две причины паузы: реклама (suspend()/resume() из main.js) и свёрнутая
  // страница — её источник сам document.hidden (без своего флага, который
  // мог бы «залипнуть», если WebView не пришлёт visibilitychange).
  var pausedAd = false;
  var primed = false;
  var inited = false;
  var fmt = 'mp3';
  var suspendTimer = null;

  var buffers = {};   // имя → { buf, offset }
  var failed = {};    // имя → true (предупреждение уже было)
  var loading = {};   // имя → Promise
  var waitingRaw = []; // [{name, ab, resolve, reject}] — нет OfflineAudioContext
  var voices = [];
  var lastStartMs = {};
  var lastStartCtx = {};
  var lastDub = {};
  var combo = {};
  var variantOverride = {};

  var readyResolve = null;
  var readyPromise = (typeof Promise !== 'undefined')
    ? new Promise(function (r) { readyResolve = r; })
    : null;

  function noop() {}

  function isPaused() { return pausedAd || !!document.hidden; }

  function warn(msg) {
    try { console.warn('[Sound] ' + msg); } catch (e) {}
  }

  /* ---------------- настройки громкости (localStorage) ---------------- */

  function loadSettings() {
    try {
      var raw = window.localStorage && localStorage.getItem(SETTINGS_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (s && typeof s === 'object') {
        ['master', 'sfx', 'ui'].forEach(function (b) {
          if (typeof s[b] === 'number' && s[b] >= 0 && s[b] <= 1) userVolumes[b] = s[b];
        });
      }
    } catch (e) {}
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(userVolumes)); } catch (e) {}
  }

  function effectiveVolume(bus) {
    if (typeof userVolumes[bus] === 'number') return userVolumes[bus];
    return typeof volumes[bus] === 'number' ? volumes[bus] : 1;
  }

  function setParam(param, v) {
    if (!ctx) return;
    try {
      param.cancelScheduledValues(ctx.currentTime);
      param.setTargetAtTime(v, ctx.currentTime, 0.012);
    } catch (e) { param.value = v; }
  }

  function applyVolumes() {
    if (!ctx) return;
    setParam(master.gain, (muted || isPaused()) ? 0 : effectiveVolume('master'));
    setParam(buses.sfx.gain, effectiveVolume('sfx'));
    setParam(buses.ui.gain, effectiveVolume('ui'));
  }

  /* ---------------- контекст и разблокировка ---------------- */

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) {
      try { ctx = new AC(); } catch (e2) { ctx = null; }
    }
    if (!ctx) return null;
    master = ctx.createGain();
    master.connect(ctx.destination);
    buses.sfx = ctx.createGain();
    buses.ui = ctx.createGain();
    buses.sfx.connect(master);
    buses.ui.connect(master);
    master.gain.value = (muted || isPaused()) ? 0 : effectiveVolume('master');
    buses.sfx.gain.value = effectiveVolume('sfx');
    buses.ui.gain.value = effectiveVolume('ui');
    if (waitingRaw.length) {
      var list = waitingRaw; waitingRaw = [];
      list.forEach(function (w) { decodeData(ctx, w.ab).then(w.resolve, w.reject); });
    }
    // Контекст, созданный в жесте, сразу «running»; при выключенном звуке
    // или на паузе ему незачем крутить аудиопоток.
    if (muted || isPaused()) suspendCtxSoon();
    return ctx;
  }

  function prime(c) {
    if (primed) return;
    try {
      var b = c.createBuffer(1, 1, 22050);
      var s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
      primed = true;
    } catch (e) {}
  }

  function tryResume(c) {
    if (c.state === 'running') return;
    try {
      var p = c.resume();
      if (p && p.then) p.then(noop, noop);
    } catch (e) {}
  }

  // Вызывать по действию пользователя (нажатие) — разрешает звук.
  function resumeContext() {
    var c = ensureCtx();
    if (!c) return;
    prime(c);
    if (!muted && !isPaused()) { tryResume(c); applyVolumes(); }
  }

  function onGesture(e) {
    // Касание пальцем даёт браузеру «активацию» только на отпускании
    // (pointerup/touchend) — на pointerdown контекст ещё не разрешён.
    if (e.type === 'pointerdown' && e.pointerType && e.pointerType !== 'mouse') return;
    if (ctx && primed && (ctx.state === 'running' || muted || isPaused())) {
      // WebView не прислал visibilitychange при возврате на экран — мастер
      // остался погашенным pauseNow(): первый же жест возвращает громкость.
      if (!muted && !isPaused() && master.gain.value < 0.001) applyVolumes();
      return;
    }
    resumeContext();
  }

  /* ---------------- пауза и mute ---------------- */

  function suspendCtxSoon() {
    if (suspendTimer) clearTimeout(suspendTimer);
    // Гасим мастер за ~40 мс и только потом останавливаем контекст —
    // иначе обрезанный на середине звук щёлкает.
    suspendTimer = setTimeout(function () {
      suspendTimer = null;
      if (ctx && (muted || isPaused()) && ctx.state === 'running') {
        try { var p = ctx.suspend(); if (p && p.then) p.then(noop, noop); } catch (e) {}
      }
    }, 40);
  }

  function pauseNow() {
    if (!ctx) return;
    applyVolumes();
    suspendCtxSoon();
  }

  // Снять паузу — только когда не осталось ни одной причины и страница на
  // экране: иначе возврат на вкладку посреди ролика или конец ролика в
  // свёрнутой вкладке включили бы звук (в т.ч. уже поставленный в очередь).
  function unpauseIfClear() {
    if (muted || isPaused() || !ctx) return;
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
    tryResume(ctx);
    applyVolumes();
  }

  function suspend() { pausedAd = true; pauseNow(); }
  function resume() { pausedAd = false; unpauseIfClear(); }

  function onVisibility() {
    if (document.hidden) pauseNow(); else unpauseIfClear();
  }

  function setMuted(m) {
    muted = !!m;
    if (!ctx) return;
    if (muted) {
      stopAll();
      applyVolumes();
      suspendCtxSoon();
    } else {
      unpauseIfClear();
    }
  }

  function isMuted() { return muted; }

  /* ---------------- загрузка ---------------- */

  function getBinary(url, type) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.responseType = type;
      x.onload = function () {
        if (x.status >= 200 && x.status < 300 && x.response) resolve(x.response);
        else reject(new Error('HTTP ' + x.status));
      };
      x.onerror = function () { reject(new Error('сеть')); };
      x.send();
    });
  }

  function getDecodeCtx() {
    if (ctx) return ctx;
    if (!decodeCtx) {
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (OAC) { try { decodeCtx = new OAC(1, 1, 48000); } catch (e) { decodeCtx = null; } }
    }
    return decodeCtx;
  }

  function decodeData(c, ab) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function ok(b) { if (!done) { done = true; resolve(b); } }
      function bad(e) { if (!done) { done = true; reject(e || new Error('не декодирован')); } }
      try {
        var p = c.decodeAudioData(ab, ok, bad);
        if (p && p.then) p.then(ok, bad);
      } catch (e) { bad(e); }
    });
  }

  function decode(ab) {
    var c = getDecodeCtx();
    if (c) return decodeData(c, ab);
    return new Promise(function (resolve, reject) {
      waitingRaw.push({ ab: ab, resolve: resolve, reject: reject });
    });
  }

  // Смещение старта: пропустить почти-тишину в начале буфера (защита от
  // задержки энкодера MP3 в декодерах, не читающих заголовок LAME).
  function leadOffset(buf) {
    var d = buf.getChannelData(0);
    var max = Math.min(d.length, Math.floor(buf.sampleRate * LEAD_SKIP_MAX_S));
    for (var i = 0; i < max; i++) {
      if (d[i] > LEAD_SKIP_THR || d[i] < -LEAD_SKIP_THR) {
        return Math.max(0, i - Math.floor(buf.sampleRate * 0.001)) / buf.sampleRate;
      }
    }
    return 0;
  }

  function urlFor(name, f) {
    return AUDIO_BASE + manifest.basePath + name + '.' + f + (VER ? '?v=' + encodeURIComponent(VER) : '');
  }

  function fetchDecode(name, f) {
    return getBinary(urlFor(name, f), 'arraybuffer').then(decode);
  }

  function loadFile(name) {
    if (!manifest || buffers[name] || failed[name]) return Promise.resolve();
    if (loading[name]) return loading[name];
    var formats = manifest.formats || ['mp3'];
    var order = [fmt].concat(formats.filter(function (f) { return f !== fmt; }));
    var p = fetchDecode(name, order[0]);
    for (var i = 1; i < order.length; i++) {
      (function (f) { p = p.then(null, function () { return fetchDecode(name, f); }); })(order[i]);
    }
    loading[name] = p.then(function (buf) {
      buffers[name] = { buf: buf, offset: leadOffset(buf) };
    }, function (e) {
      failed[name] = true;
      warn('файл «' + name + '» не загрузился (' + (e && e.message ? e.message : e) + ') — событие без звука');
    }).then(function () { delete loading[name]; });
    return loading[name];
  }

  function loadAll(names) {
    var queue = names.slice();
    function worker() {
      if (!queue.length) return Promise.resolve();
      return loadFile(queue.shift()).then(worker);
    }
    var ws = [];
    for (var i = 0; i < LOAD_CONCURRENCY; i++) ws.push(worker());
    return Promise.all(ws);
  }

  function activeIndex(id, ev) {
    if (variantOverride.hasOwnProperty(id)) return variantOverride[id];
    return ev.active || 0;
  }

  function preloadList() {
    var ids = Object.keys(manifest.events);
    ids.sort(function (a, b) {
      var ia = PRELOAD_FIRST.indexOf(a), ib = PRELOAD_FIRST.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var names = [];
    ids.forEach(function (id) {
      var ev = manifest.events[id];
      var v = ev.variants[activeIndex(id, ev)];
      (v ? v.files : []).forEach(function (f) { if (names.indexOf(f) < 0) names.push(f); });
    });
    return names;
  }

  function pickFormat() {
    var formats = manifest.formats || ['mp3'];
    try {
      var a = document.createElement('audio');
      if (formats.indexOf('ogg') >= 0 && a.canPlayType && a.canPlayType('audio/ogg; codecs="opus"')) return 'ogg';
    } catch (e) {}
    return formats.indexOf('mp3') >= 0 ? 'mp3' : formats[0];
  }

  function start() {
    getBinary(AUDIO_BASE + 'manifest.json' + (VER ? '?v=' + encodeURIComponent(VER) : ''), 'text').then(function (text) {
      manifest = JSON.parse(text);
      volumes = manifest.buses || volumes;
      fmt = pickFormat();
      applyVolumes();
      return loadAll(preloadList());
    }).then(null, function (e) {
      if (!manifest) warn('манифест звука не загрузился (' + (e && e.message ? e.message : e) + ') — игра без звука');
    }).then(function () { if (readyResolve) readyResolve(); });
  }

  /* ---------------- воспроизведение ---------------- */

  function rnd() { return Math.random() * 2 - 1; }

  function pruneVoices(now) {
    voices = voices.filter(function (v) { return v.end > now; });
  }

  function fadeStop(v, t) {
    var now = ctx.currentTime;
    try {
      var g = v.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + t);
      v.src.stop(now + t + 0.005);
    } catch (e) {}
    v.end = Math.min(v.end, now + t);
  }

  function voicesOf(id, now) {
    return voices.filter(function (v) { return v.ev === id && v.end > now; });
  }

  // Дубль — случайный из ЗАГРУЖЕННЫХ, без повтора подряд. Сбойный или ещё
  // не пришедший файл не выбирается: иначе при одном битом дубле из пяти
  // молчал бы каждый пятый ход. Не загружено ничего — первый несбойный
  // (play() попросит его загрузку и промолчит).
  function pickDub(id, files) {
    if (files.length < 2) return files[0];
    var ok = [];
    for (var k = 0; k < files.length; k++) if (buffers[files[k]]) ok.push(k);
    if (!ok.length) {
      for (k = 0; k < files.length; k++) if (!failed[files[k]]) return files[k];
      return files[0];
    }
    var j = Math.floor(Math.random() * ok.length);
    if (ok[j] === lastDub[id] && ok.length > 1) j = (j + 1 + Math.floor(Math.random() * (ok.length - 1))) % ok.length;
    lastDub[id] = ok[j];
    return files[ok[j]];
  }

  function comboStep(id, cfg, nowMs) {
    var c = combo[id] || (combo[id] = { step: -1, at: 0 });
    c.step = (nowMs - c.at <= cfg.windowMs) ? Math.min(c.step + 1, cfg.steps.length - 1) : 0;
    c.at = nowMs;
    return c.step;
  }

  function play(id, opts) {
    opts = opts || {};
    if (muted || isPaused() || !manifest || !ctx) return null;
    var ev = manifest.events[id];
    if (!ev) return null;
    var vi = (typeof opts.variant === 'number') ? opts.variant : activeIndex(id, ev);
    var variant = ev.variants[vi];
    if (!variant || !variant.files.length) return null;

    var nowMs = Date.now();
    if (ev.minGapMs && !opts.force && lastStartMs[id] && nowMs - lastStartMs[id] < ev.minGapMs) return null;

    var name, rate = 1;
    if (ev.combo) {
      var step = comboStep(id, ev.combo, nowMs);
      if (variant.mode === 'steps') name = variant.files[Math.min(step, variant.files.length - 1)];
      else { name = variant.files[0]; rate = Math.pow(2, ev.combo.steps[step] / 12); }
    } else {
      name = pickDub(id, variant.files);
    }
    var entry = buffers[name];
    if (!entry) { loadFile(name); return null; }

    rate *= 1 + rnd() * (ev.pitchVar || 0);
    // Своя громкость у альтернативы (tools/match_variant_volume.py) — чтобы
    // смена active не ломала порядок громкости; иначе — громкость события.
    var baseVol = variant.volume != null ? variant.volume : (ev.volume == null ? 1 : ev.volume);
    var vol = baseVol * (1 + rnd() * (ev.volVar || 0));
    var now = ctx.currentTime;
    var when = now;
    pruneVoices(now);

    if (ev.combo && ev.combo.rollMs && lastStartCtx[id] != null) {
      when = Math.max(when, lastStartCtx[id] + ev.combo.rollMs / 1000);
      if (when - now > 0.5) when = now; // старый отсчёт после паузы — не копим очередь
    }
    if (ev.queueAfter) {
      Object.keys(ev.queueAfter).forEach(function (other) {
        voicesOf(other, now).forEach(function (v) {
          when = Math.max(when, v.end - ev.queueAfter[other] / 1000);
        });
      });
    }
    if (ev.cancels) {
      Object.keys(ev.cancels).forEach(function (other) {
        var since = now - ev.cancels[other] / 1000;
        voicesOf(other, now).forEach(function (v) { if (v.t0 >= since) fadeStop(v, 0.012); });
      });
    }
    var mine = voicesOf(id, now);
    var maxI = ev.maxInstances || 4;
    while (mine.length >= maxI) { fadeStop(mine.shift(), STEAL_FADE_S); }
    var live = voices.filter(function (v) { return v.end > now; });
    while (live.length >= MAX_VOICES) { fadeStop(live.shift(), STEAL_FADE_S); }

    var group = manifest.groups && manifest.groups[ev.group];
    var bus = buses[(group && group.bus) || 'sfx'] || buses.sfx;
    var src = ctx.createBufferSource();
    var g = ctx.createGain();
    src.buffer = entry.buf;
    src.playbackRate.value = rate;
    g.gain.value = vol;
    src.connect(g);
    g.connect(bus);
    src.__sfx = { event: id, file: name, rate: rate, volume: vol, when: when, variant: vi };
    var voice = { src: src, gain: g, ev: id, t0: when, end: when + (entry.buf.duration - entry.offset) / rate };
    src.onended = function () {
      var i = voices.indexOf(voice);
      if (i >= 0) voices.splice(i, 1);
      try { g.disconnect(); } catch (e) {}
    };
    try { src.start(when, entry.offset); } catch (e) { return null; }
    voices.push(voice);
    lastStartMs[id] = nowMs;
    lastStartCtx[id] = when;
    return voice;
  }

  function stopAll() {
    if (!ctx) return;
    voices.slice().forEach(function (v) { fadeStop(v, 0.02); });
  }

  // Снять голоса, которые поставлены в очередь (queueAfter), но ещё не
  // начались: открытка главы и «глава открыта» ждут конца мелодии победы, и
  // если игрок уже ушёл с экрана победы, прозвучали бы поверх следующего
  // экрана — или после рекламы (на паузе часы контекста стоят, очередь
  // ждёт вместе с ними). Уже звучащие доигрывают. ids — список событий,
  // без него — все ожидающие.
  function cancelPending(ids) {
    if (!ctx) return;
    var now = ctx.currentTime;
    voices = voices.filter(function (v) {
      if (v.t0 <= now || (ids && ids.indexOf(v.ev) < 0)) return true;
      try { v.gain.disconnect(); } catch (e) {}
      try { v.src.stop(0); } catch (e) {} // стоп раньше старта — источник не звучит вовсе
      v.end = now;
      return false;
    });
  }

  /* ---------------- API игры ---------------- */

  function init() {
    if (inited) return;
    inited = true;
    loadSettings();
    // Звук останавливается при сворачивании страницы (п.1.3).
    document.addEventListener('visibilitychange', onVisibility);
    ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'click', 'keydown'].forEach(function (t) {
      document.addEventListener(t, onGesture, { capture: true, passive: true });
    });
    setTimeout(start, 0);
  }

  // Ход на поле (nonogram.js → main.js onMove): fill/cross/erase — звук
  // клетки, hint — подсказка, reveal — «Проверить» исправил. Авто-крестики
  // ('auto') молчат: они в том же кадре, что и звук хода игрока.
  function cell(kind) {
    var id = CELL_EVENTS[kind];
    if (id) play(id);
  }

  function setVolume(bus, v) {
    if (bus !== 'master' && bus !== 'sfx' && bus !== 'ui') return;
    v = Math.max(0, Math.min(1, +v || 0));
    userVolumes[bus] = v;
    saveSettings();
    applyVolumes();
  }

  function getVolume(bus) { return effectiveVolume(bus); }

  // Страница прослушивания audio-test.html: выбрать вариант события.
  function setVariant(id, idx) {
    if (!manifest || !manifest.events[id]) return Promise.resolve();
    variantOverride[id] = idx;
    var v = manifest.events[id].variants[idx];
    return loadAll(v ? v.files : []);
  }

  function loadVariants() {
    if (!manifest) return Promise.resolve();
    var names = [];
    Object.keys(manifest.events).forEach(function (id) {
      manifest.events[id].variants.forEach(function (v) {
        v.files.forEach(function (f) { if (names.indexOf(f) < 0) names.push(f); });
      });
    });
    return loadAll(names);
  }

  function fileInfo(name) {
    var e = buffers[name];
    if (e) return { duration: e.buf.duration - e.offset, loaded: true };
    return { duration: 0, loaded: false, failed: !!failed[name] };
  }

  return {
    init: init, resumeContext: resumeContext,
    play: play, cell: cell,
    // Прежние имена (до ТЗ №55): tick — клетка, found/wrong — в игре не
    // вызываются, оставлены псевдонимами «проверка чистая/исправлено».
    tick: function () { play('cellFill'); },
    found: function () { play('checkClean'); },
    wrong: function () { play('checkFixed'); },
    win: function () { play('win'); },
    lineClosed: function () { play('lineClosed'); },
    suspend: suspend, resume: resume,
    setMuted: setMuted, isMuted: isMuted,
    setVolume: setVolume, getVolume: getVolume,
    stopAll: stopAll, cancelPending: cancelPending,
    ready: function () { return readyPromise; },
    getManifest: function () { return manifest; },
    getFormat: function () { return manifest ? fmt : ''; },
    // Для проверок (tools/audio_check.py, tools/test_audio_live.js).
    status: function () {
      return {
        manifest: !!manifest, format: manifest ? fmt : '',
        loaded: Object.keys(buffers), failed: Object.keys(failed),
        context: ctx ? ctx.state : 'none', voices: voices.length,
      };
    },
    setVariant: setVariant, loadVariants: loadVariants, fileInfo: fileInfo,
  };
})();
