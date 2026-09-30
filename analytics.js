/* ============================================================
   analytics.js — ТЗ №57. Событийная аналитика в Яндекс Метрике.

   Тонкая обёртка: один вызов Analytics.event(имя, параметры). Ничего не
   ждёт, никогда не бросает исключение, не меняет поведение игры (правило
   студии K-09: обёртка над внешним вызовом не ломает вызывающего). Любой
   сбой внутри — молча глушится, игра об этом не узнаёт.

   Порядок (п.2 ТЗ):
     1. До Analytics.start() события копятся в очереди в памяти (до 50,
        лишние отбрасываются).
     2. main.js зовёт start() сразу после Platform.ready() (gameReady
        площадки). Дальше, когда страница догрузилась (событие load окна —
        иначе висящий mc.yandex.ru держал бы документ в «загрузке»), в DOM
        добавляется фрейм-изолятор metrika.html, а в него — async-скрипт
        mc.yandex.ru/metrika/tag.js.
     3. Скрипт загрузился — очередь уходит в Метрику, дальше события
        отправляются сразу. Не загрузился (адблок, нет сети) — очередь
        молча пропадает, новые события больше не копятся.

   Когда отправка включена (п.3–4 ТЗ): только в сборке для площадки
   (build.py подставляет площадку вместо плейсхолдера ниже), только если
   номер счётчика заведён (COUNTER_ID > 0) и только не на локальной машине
   (см. isLocalRun: file:/http:, localhost, частные адреса сети). Запуск из
   исходников в сеть не шлёт ничего даже с номером счётчика — плейсхолдер
   площадки там не подставлен. С ?debug=1 каждое событие печатается в
   консоль в любом режиме.

   Параметры цели уходят в Метрику вложенными под ID цели, а у целей с
   номером картинки (level) — ещё и под этим номером (решение основателя
   28.09, вариант «в»):
     reachGoal('level_win', { level_win: { '3': { sec: 41, moves: 7, undos: 0 } }, platform, build })
     reachGoal('level_start', { level_start: { '3': 1 }, platform, build })
     reachGoal('level_start', { level_start: { daily: 1 }, platform, build })
   В отчёте «Параметры визитов» дерево тогда «цель → картинка → параметр»:
   по каждой картинке видны входы, победы, время и ходы (кривая
   сложности); сводка по всем картинкам — сложением. Если у цели кроме
   level ничего нет, лист — 1. Цели без level (game_loaded, return_day,
   rewarded_*, chapter_open) — «цель → параметр → значение». Плоские
   level/sec разных целей слились бы в одну ветку, а level соседней
   веткой к sec не дал бы среднего времени по картинке.

   Параметры визита: platform ('vk' | 'yandex' | 'dev') и build (плашка
   версии BUILD_VERSION) — с хитом визита И с каждой целью: Метрика режет
   визит после простоя (тайм-аут визита), и визит, начатый целью без
   перезагрузки игры, иначе остался бы без platform/build. 'dev' — тестовый
   хост (путь /games-dev/, стенд Fanatat/games-dev); бой (любой другой
   адрес) dev не получает никогда.

   Персональные данные (п.5 ТЗ): модуль не читает ID/имя/аватар игрока
   ни у одной площадки. Адрес ВК-фрейма несёт vk_user_id/sign в query, а
   document.referrer — адрес страницы ВК. Опции init/hit (url, referrer)
   чистят только собственные хиты счётчика — служебные запросы самого
   tag.js (телеметрия его внутренних ошибок, синхронизация с операторами
   связи по настройкам сервера Метрики) читают location.href и
   document.referrer окна, где tag.js выполняется, напрямую. Поэтому
   tag.js грузится НЕ в окно игры, а в свой фрейм того же сайта:
   metrika.html без query/hash, referrerpolicy="no-referrer" (реферер
   фрейма пуст). Перед загрузкой tag.js фрейм проверяется (frameIsClean):
   если в его адресе есть query/hash или реферер не пуст — tag.js не
   грузится вовсе. Адрес игры (origin + путь) и origin реферера передаются
   хиту явно. Проверено живым прогоном с настоящим tag.js, включая
   принудительную внутреннюю ошибку tag.js и синхронизацию с операторами
   (tools/acceptance_analytics.js, п.8).
   ============================================================ */

window.Analytics = (function () {
  // Номер счётчика Метрики — ЕДИНСТВЕННОЕ место в коде (п.6 ТЗ), заведён
  // основателем 28.09. 0 = счётчика нет: tag.js не грузится, в сеть не
  // уходит ничего, события видны только в консоли при ?debug=1; при 0
  // build.py печатает громкое предупреждение (сборку не роняет).
  var COUNTER_ID = 113113659;

  // Площадка сборки — build.py подставляет 'vk' или 'yandex' и падает, если
  // подстановка не прошла. В исходнике остаётся плейсхолдер.
  var BUILD_PLATFORM = 'vk';

  var TAG_URL    = 'https://mc.yandex.ru/metrika/tag.js';
  // Фрейм-изолятор tag.js (см. шапку): файл сборки рядом с index.html.
  var FRAME_SRC  = 'metrika.html';
  var FRAME_MARK = 'data-metrika-frame';
  var QUEUE_MAX  = 50;
  // Событие load окна может задержать зависший сторонний ресурс — тогда
  // фрейм ставится не позже чем через столько после start().
  var MOUNT_FALLBACK_MS = 5000;

  var _debug    = false;
  var _enabled  = false;
  var _offWhy   = '';
  var _platform = 'dev';
  var _build    = 'unknown';
  var _state    = 'queue'; // 'queue' -> 'loading' -> 'ready' | 'failed'
  var _started  = false;
  var _queue    = [];
  var _frame    = null;    // <iframe> metrika.html
  var _win      = null;    // его окно — в нём живут ym() и tag.js
  var _mountTimer = 0;

  // Локальный/ручной запуск — не шлём вовсе. Бой ВК и Яндекса — только
  // https на публичном хосте; http:/file:, localhost, *.local и частные
  // адреса сети (сборка, открытая с телефона по 192.168.x.x) — ручная
  // проверка, её визиты в счётчик не пишем.
  function isLocalRun(proto, host) {
    if (proto !== 'https:') return true;
    host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || /\.(localhost|local)$/.test(host)) return true;
    if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
    var ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
    if (ip) {
      var a = +ip[1], b = +ip[2];
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    return /^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  }

  try {
    _debug = /(^|[?&])debug=1(&|$)/.test(location.search);
    var isBuild = BUILD_PLATFORM === 'vk' || BUILD_PLATFORM === 'yandex';
    var isLocal = isLocalRun(location.protocol, location.hostname);
    var isTestHost = /\/games-dev\//.test(location.pathname);
    _platform = (isBuild && !isLocal && !isTestHost) ? BUILD_PLATFORM : 'dev';
    if (!isBuild)             _offWhy = 'запуск из исходников';
    else if (!(COUNTER_ID > 0)) _offWhy = 'номер счётчика не задан';
    else if (isLocal)         _offWhy = 'локальный запуск';
    _enabled = !_offWhy;
  } catch (e) { _enabled = false; _offWhy = 'ошибка окружения'; }

  // Только примитивы (число/строка/булево) — объект игры в Метрику не
  // уходит ни по ошибке, ни по ссылке.
  function cleanParams(params) {
    var out = {};
    if (!params || typeof params !== 'object') return out;
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      var t = typeof v;
      if (t === 'number') { if (isFinite(v)) out[k] = v; }
      else if (t === 'string' || t === 'boolean') out[k] = v;
    }
    return out;
  }

  function debugPrint(name, p, note) {
    if (!_debug) return;
    try {
      console.log('[analytics] ' + name + ' ' + JSON.stringify(p) + (note ? ' (' + note + ')' : ''));
    } catch (e) { /* консоль недоступна — не важно */ }
  }

  // Вызов ym() окна-изолятора. Аргументы пересобираются JSON'ом ФРЕЙМА —
  // tag.js получает объекты своего окна, а не ссылки на объекты игры.
  // ym ищется каждый раз заново: tag.js может заменить функцию очереди.
  function ym(args) {
    var w = _win;
    w.ym.apply(w, w.JSON.parse(JSON.stringify(args)));
  }

  // Ветка цели: { '3': { sec: 41 } } — под номером картинки, если он есть
  // (см. шапку), иначе сами параметры. null — параметров нет.
  function goalBranch(p) {
    var hasLevel = Object.prototype.hasOwnProperty.call(p, 'level');
    var rest = {}, has = false;
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k) || (hasLevel && k === 'level')) continue;
      rest[k] = p[k];
      has = true;
    }
    if (!hasLevel) return has ? rest : null;
    var branch = {};
    branch[String(p.level)] = has ? rest : 1;
    return branch;
  }

  // Сети нет (navigator.onLine === false) — цель молча пропадает: запрос
  // всё равно не дойдёт, а браузер на каждый такой запрос пишет в консоль
  // сетевую ошибку. Параметры — веткой под ID цели (см. шапку), рядом —
  // параметры визита; цель без параметров уходит без своей ветки.
  function send(name, p) {
    try {
      if (navigator.onLine === false) return;
      var params = { platform: _platform, build: _build };
      var branch = goalBranch(p);
      if (branch) params[name] = branch;
      ym([COUNTER_ID, 'reachGoal', name, params]);
    } catch (e) { /* молча */ }
  }

  function flush() {
    var q = _queue;
    _queue = [];
    for (var i = 0; i < q.length; i++) send(q[i][0], q[i][1]);
  }

  // Analytics.event('level_win', { level: 3, sec: 41 }) — отправить цель.
  function event(name, params) {
    try {
      if (typeof name !== 'string' || !name) return;
      var p = cleanParams(params);
      if (!_enabled) { debugPrint(name, p, 'не отправлено: ' + _offWhy); return; }
      if (_state === 'failed') { debugPrint(name, p, 'не отправлено: tag.js не загрузился'); return; }
      if (_state === 'ready') { debugPrint(name, p); send(name, p); return; }
      if (_queue.length >= QUEUE_MAX) { debugPrint(name, p, 'очередь полна — отброшено'); return; }
      debugPrint(name, p, 'в очереди');
      _queue.push([name, p]);
    } catch (e) { /* аналитика не ломает игру */ }
  }

  function cleanPageUrl() {
    var origin = location.origin || (location.protocol + '//' + location.host);
    return origin + location.pathname;
  }

  function cleanReferrer() {
    var m = /^(https?:\/\/[^\/?#]+)/.exec(document.referrer || '');
    return m ? m[1] + '/' : '';
  }

  function fail(why) {
    _state = 'failed';
    _queue = [];
    if (_debug) console.log('[analytics] ' + why + ' — события этого запуска отброшены');
  }

  // Фрейм — именно наш пустой metrika.html, и tag.js в нём не увидит ни
  // адреса игры, ни реферера. Иначе tag.js не грузится вовсе.
  function frameIsClean(w) {
    var d = w.document;
    return !!d && !!d.documentElement && d.documentElement.getAttribute(FRAME_MARK) === '1' &&
      !w.location.search && !w.location.hash && !d.referrer && typeof w.ym === 'function';
  }

  function onFrameLoad() {
    try {
      if (_state !== 'loading' || _win) return;
      var w = _frame.contentWindow;
      if (!w || !frameIsClean(w)) { fail('фрейм Метрики не прошёл проверку'); return; }
      _win = w;
      var d = w.document;
      try { d.title = document.title; } catch (e) { /* заголовок — не важно */ }
      var pageUrl = cleanPageUrl();
      var referrer = cleanReferrer();
      // defer: авто-хит init'а не отправляется — единственный хит визита
      // ниже, с адресом игры без query/hash и параметрами визита.
      // accurateTrackBounce выключен: отказы для игры не показатель (визит
      // и так несёт game_loaded в первую секунду), а его таймерный запрос
      // notBounce через 15 с уходит и без сети — красная сетевая строка в
      // консоли игрока (К4 ТЗ).
      ym([COUNTER_ID, 'init', {
        defer: true,
        url: pageUrl,
        referrer: referrer,
        clickmap: false,
        trackLinks: false,
        accurateTrackBounce: false,
        webvisor: false,
        trackHash: false,
      }]);
      ym([COUNTER_ID, 'hit', pageUrl, {
        referer: referrer,
        title: String(document.title || ''),
        params: { platform: _platform, build: _build },
      }]);
      var s = d.createElement('script');
      s.async = true;
      s.src = TAG_URL;
      s.onload = function () {
        if (_state !== 'loading') return;
        _state = 'ready';
        flush();
      };
      s.onerror = function () { fail('tag.js не загрузился'); };
      (d.head || d.documentElement).appendChild(s);
    } catch (e) {
      fail('ошибка фрейма Метрики');
    }
  }

  function mountFrame() {
    try {
      if (_frame || _state !== 'loading') return;
      clearTimeout(_mountTimer);
      window.removeEventListener('load', mountFrame);
      var f = document.createElement('iframe');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.setAttribute('aria-hidden', 'true');
      f.setAttribute('tabindex', '-1');
      f.title = '';
      // Во весь экран, но невидим и прозрачен для касаний: вне потока
      // раскладки, а tag.js видит настоящий размер окна.
      f.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0;margin:0;padding:0;' +
        'visibility:hidden;pointer-events:none;z-index:-1;';
      f.onload = onFrameLoad;
      f.src = FRAME_SRC;
      _frame = f;
      (document.body || document.documentElement).appendChild(f);
    } catch (e) {
      fail('фрейм Метрики не создан');
    }
  }

  // Зовётся один раз после gameReady (main.js, сразу за Platform.ready()).
  function start() {
    try {
      if (_started) return;
      _started = true;
      if (!_enabled) {
        _queue = [];
        if (_debug) console.log('[analytics] отправка выключена: ' + _offWhy + ' (platform=' + _platform + ')');
        return;
      }
      _build = String(window.BUILD_VERSION || 'unknown');
      _state = 'loading';
      if (_debug) console.log('[analytics] старт: platform=' + _platform + ', build=' + _build);
      if (document.readyState === 'complete') { mountFrame(); return; }
      window.addEventListener('load', mountFrame);
      _mountTimer = setTimeout(mountFrame, MOUNT_FALLBACK_MS);
    } catch (e) {
      fail('ошибка старта');
    }
  }

  return {
    event: event,
    start: start,
  };
})();
