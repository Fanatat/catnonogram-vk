/* ============================================================
   adapters/vk_bridge.js — нативный @vkontakte/vk-bridge (v3.0.2, вшит
   локально как vk-bridge.min.js, без CDN).
   Подставляется build.py как platform.js в vk-сборку.

   Публичный интерфейс 1:1 повторяет боевой platform.js (Яндекс),
   промодерированный и не подлежащий изменению: init, ready, getLang,
   isAvailable, save, load, now, showInterstitial(onDone),
   showBonusAd(onResult) (бонус «за рекламу» = interstitial, 2026-10-01). Это НЕ «канонiчный контракт v2» из
   Словохода (там gameReady/другие сигнатуры рекламы/нет now()) —
   имена и сигнатуры совпадают с main.js этой игры, чтобы не трогать
   общий для обеих сборок main.js.

   Защита от зависания (баг «вечная загрузка»):
   VK Bridge реализует send() как Promise, который резолвится только
   если VK-клиент ответил. В двух сценариях ответа НЕТ:
     1. Страница открыта напрямую (не в iframe/native app VK):
        isEmbedded() = false, send() ушёл бы в никуда.
     2. Страница в iframe, но VK не обрабатывает запросы
        (URL не зарегистрирован, ранний lifecycle и т.д.).
   Фикс: vkBridge.isEmbedded() проверяем ДО send();
         таймаут 2.5 сек покрывает сценарий 2.
   При провале — dev-режим (isAvailable=false, дев-бейдж, игра без сейва/рекламы).

   Частота записи (доработка, п.3): dev.vk.com документирует лимит
   VKWebAppStorageSet в 1000 вызовов/час на пользователя. main.js шлёт
   Platform.save() по своему 5-секундному дебаунсу хода — этого структурно
   достаточно, чтобы при активной непрерывной игре подойти к лимиту вплотную
   (расчёт — в отчёте). Здесь, внутри VK-адаптера (не трогая main.js и не
   влияя на Яндекс-сборку): базовый дебаунс поднят до 10 с, плюс счётчик
   реально отправленных записей за скользящий час с мягким торможением —
   чем ближе к лимиту, тем длиннее пауза перед следующей отправкой. Ничего
   не выбрасывается: каждый save() лишь обновляет "последнее состояние",
   которое рано или поздно уйдёт целиком (правило студии — сейв всегда
   пишется целиком, поэтому объединение нескольких вызовов в один безопасно).
   События (уход со страницы, показ рекламы) форсируют немедленный флаш —
   не ждут дебаунса.
   ============================================================ */

// Чистые функции без побочных эффектов — вынесены наружу IIFE, чтобы их
// можно было протестировать в Node без мока vkBridge/window (см.
// tools/test_vk_write_throttle.js).
var VK_SAVE_DEBOUNCE_MS      = 10000; // базовый дебаунс адаптера
var VK_WRITE_LIMIT_PER_HOUR  = 1000;  // dev.vk.com: лимит VKWebAppStorageSet
var VK_SOFT_BRAKE_THRESHOLD  = 700;   // с этого количества/час начинаем тормозить
var VK_MAX_DEBOUNCE_MS       = 60000; // потолок паузы вплотную к лимиту

// 3500 байт: инженерный бюджет студии, подтверждён решением основателя
// 22.08.2026 (ТЗ №13, п.3.5). Реальный лимит ВК первоисточником не
// подтверждён (вторичные источники называют около 4КБ и более жёсткую
// границу для сериализованных объектов — 3500 взято с запасом от этой
// оценки); при появлении официальной цифры на dev.vk.com — пересмотреть.
// Больше долгом не числится. Единственный источник истины для байтового
// лимита сейва (см. save.js enforceSizeGuard) — общий код (main.js) его
// не задаёт.
var VK_SAVE_SIZE_GUARD_BYTES = 3500;

// Выбрасывает из лога отметки времени старше скользящего часа. Чистая
// функция — возвращает НОВЫЙ массив, не мутирует переданный.
function vkPruneWriteLog(writeLog, nowMs) {
  var hourAgo = nowMs - 3600000;
  var i = 0;
  while (i < writeLog.length && writeLog[i] < hourAgo) i++;
  return writeLog.slice(i);
}

// ТЗ №59 (Н-02): страница уже скрыта (ВК свёрнут) — запись уходит сразу,
// без дебаунса: main.js кладёт свежий черновик своим обработчиком
// visibilitychange ПОСЛЕ того, как адаптер уже отправил старый буфер, и
// 10-секундный таймер оставлял последние ходы только в памяти — ВК мог
// выгрузить страницу раньше. Тот же мягкий тормоз: с порога торможения
// (≥700 записей за час) — обычный отложенный путь. Чистая функция.
function vkShouldSendNow(pageHidden, writeCountLastHour) {
  return !!pageHidden && writeCountLastHour < VK_SOFT_BRAKE_THRESHOLD;
}

// Сколько миллисекунд ждать перед следующей отправкой, исходя из числа
// реальных записей за последний скользящий час. До порога — базовый
// дебаунс; после — линейный рост до потолка на подходе к лимиту.
function vkComputeDebounceDelay(writeCountLastHour) {
  if (writeCountLastHour < VK_SOFT_BRAKE_THRESHOLD) return VK_SAVE_DEBOUNCE_MS;
  var span = VK_WRITE_LIMIT_PER_HOUR - VK_SOFT_BRAKE_THRESHOLD;
  var over = span > 0 ? (writeCountLastHour - VK_SOFT_BRAKE_THRESHOLD) / span : 1;
  var ramped = VK_SAVE_DEBOUNCE_MS + over * (VK_MAX_DEBOUNCE_MS - VK_SAVE_DEBOUNCE_MS);
  return Math.min(VK_MAX_DEBOUNCE_MS, Math.max(VK_SAVE_DEBOUNCE_MS, ramped));
}

if (typeof window !== 'undefined') {
window.Platform = (function () {
  var STORAGE_KEY  = 'nonogram_save';
  var INIT_TIMEOUT = 2500; // мс — после этого уходим в dev-режим
  var available = false;

  function hasBridge() {
    return typeof vkBridge !== 'undefined';
  }

  // Инициализация. Как и Platform.init() у Яндекса — никогда не падает:
  // нет VK-окружения (локальный запуск/чужой браузер) → dev-режим.
  function init() {
    if (!hasBridge()) {
      console.warn('[Platform] VK Bridge не найден — dev-режим.');
      return Promise.resolve(false);
    }
    if (!vkBridge.isEmbedded()) {
      console.warn('[Platform] Не VK-окружение (standalone) — dev-режим.');
      return Promise.resolve(false);
    }

    var timeoutP = new Promise(function (resolve) {
      setTimeout(function () { resolve('timeout'); }, INIT_TIMEOUT);
    });

    return Promise.race([vkBridge.send('VKWebAppInit'), timeoutP])
      .then(function (res) {
        if (res === 'timeout') {
          console.warn('[Platform] VKWebAppInit timeout (' + INIT_TIMEOUT + 'ms) — dev-режим.');
          return false;
        }
        available = true;
        console.log('[Platform] VK Bridge init OK.');
        fetchClientVersion();
        return true;
      })
      .catch(function (err) {
        console.error('[Platform] VKWebAppInit ошибка:', err);
        return false;
      });
  }

  // Фикс 10: VKWebAppResizeWindow (был добавлен в фиксе 9C) убран полностью
  // и звать больше нельзя ни при каких условиях. Живым прогоном на реальном
  // устройстве подтверждено: вызов ПЕРЕБИВАЕТ размер iframe, заданный в
  // кабинете (кабинет — 630×600, широкоформатный режим ОТКЛЮЧЁН; код
  // запросил 780×908, и ВК ПРИМЕНИЛ запрошенное вместо кабинетного). Игра
  // обязана вписываться в фактический размер iframe (Фикс 8/9A —
  // computeBaseCell() меряет реальный контейнер), а не пытаться его менять.

  // У VK нет аналога Yandex LoadingAPI.ready() — no-op.
  function ready() {}

  // VK передаёт vk_language в URL синхронно — не нужен async.
  function getLang() {
    try {
      var p = new URLSearchParams(location.search);
      var l = p.get('vk_language');
      if (l) return l.slice(0, 2);
    } catch (e) { /* падать нельзя */ }
    return (navigator.language || 'ru');
  }

  function isAvailable() { return available; }

  // Локальный dev-сейв (localStorage), только когда платформы нет — тот же
  // приём, что и в боевом platform.js (Яндекс), чтобы прогресс переживал
  // перезагрузку при ручной проверке вне VK-контейнера.
  var DEV_SAVE_KEY = 'nonogram_dev_save_vk';

  // Частота записи (см. заголовок файла): _pendingState — последнее
  // состояние на отправку (каждый save() просто обновляет его — сейв
  // всегда целиком, поэтому потерь при объединении вызовов нет);
  // _flushTimer — текущий отложенный вызов; _writeLog — отметки времени
  // РЕАЛЬНО отправленных vkBridge.send за скользящий час (для торможения).
  var _pendingState = null;
  var _flushTimer    = null;
  var _writeLog      = [];

  // Аудит 2026-10-05, F03: запись, на которую мост ответил ошибкой, раньше
  // молча терялась (_pendingState обнулялся до ответа). Теперь:
  //  - каждая отправка получает номер (_sendSeq); _ackedSeq — номер
  //    последней подтверждённой. Неудачная отправка возвращается в очередь
  //    только если за время запроса не появилось более свежее состояние и
  //    ни одна более поздняя запись не подтверждена — старый повтор не
  //    может затереть новый прогресс;
  //  - повтор — с нарастающей паузой (VK_RETRY_BASE_MS … VK_RETRY_MAX_MS),
  //    попытки считаются в _writeLog, мягкий тормоз лимита работает как
  //    для обычных записей;
  //  - пока запрос в полёте, обычный флаш ждёт его конца (порядок записей
  //    на стороне ВК не гарантирован); при сворачивании страницы отправка
  //    идёт сразу — позже может не быть шанса.
  var VK_RETRY_BASE_MS = 2000;
  var VK_RETRY_MAX_MS  = 60000;
  var VK_WRITE_TIMEOUT_MS = 15000;
  var _sendSeq = 0, _ackedSeq = 0, _writesInFlight = 0, _retryAttempt = 0;

  // F01: пока облачный сейв не прочитан (ошибка/таймаут StorageGet), писать
  // в тот же ключ нельзя — игра стартовала с пустым состоянием и затёрла бы
  // прежний прогресс. Состояние копится в _pendingState и уйдёт только
  // после успешного повторного чтения (см. vkRetryLoad ниже).
  var _saveBlocked = false;

  function vkScheduleRetry() {
    if (_flushTimer) return;
    var delay = Math.min(VK_RETRY_MAX_MS, VK_RETRY_BASE_MS * Math.pow(2, _retryAttempt));
    _retryAttempt++;
    _flushTimer = setTimeout(vkFlushPending, delay);
  }

  function vkFlushPending() {
    _flushTimer = null;
    if (_pendingState == null || _saveBlocked) return;
    if (_writesInFlight > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      return; // доведёт завершение текущего запроса (см. ниже)
    }
    var toSend = _pendingState;
    _pendingState = null;
    var seq = ++_sendSeq;
    _writeLog = vkPruneWriteLog(_writeLog, Date.now());
    _writeLog.push(Date.now());
    _writesInFlight++;
    // Таймаут 15 с: молчащий мост не должен навсегда занять «полёт» и
    // остановить обычные записи (опоздавший успех безвреден — сейв целиком).
    withTimeout(vkBridge.send('VKWebAppStorageSet', {
      key:   STORAGE_KEY,
      value: JSON.stringify(toSend),
    }), VK_WRITE_TIMEOUT_MS).then(function () {
      _writesInFlight--;
      if (seq > _ackedSeq) _ackedSeq = seq;
      _retryAttempt = 0;
      if (_pendingState != null && !_flushTimer) vkFlushPending();
    }, function (e) {
      _writesInFlight--;
      console.error('[Platform] StorageSet ошибка (повтор запланирован):', e);
      if (_pendingState == null && seq > _ackedSeq) _pendingState = toSend;
      if (_pendingState != null) vkScheduleRetry();
    });
  }

  // Форсирует немедленную отправку отложенного состояния (если есть) —
  // события «уход со страницы» / «перед рекламой» не должны ждать дебаунса.
  function vkFlushNow() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    vkFlushPending();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') vkFlushNow();
    });
  }

  function save(fullState) {
    if (!available) {
      try { localStorage.setItem(DEV_SAVE_KEY, JSON.stringify(fullState)); } catch (e) { /* dev-режим, падать нельзя */ }
      return Promise.resolve();
    }
    _pendingState = fullState;
    _writeLog = vkPruneWriteLog(_writeLog, Date.now());
    if (vkShouldSendNow(document.visibilityState === 'hidden', _writeLog.length)) {
      vkFlushNow();
      return Promise.resolve();
    }
    if (!_flushTimer) {
      var delay = vkComputeDebounceDelay(_writeLog.length);
      _flushTimer = setTimeout(vkFlushPending, delay);
    }
    return Promise.resolve();
  }

  // 2026-09-06: баг-репорт основателя, Android — «долго грузится и в итоге
  // падает с ошибкой загрузки». init() (VKWebAppInit) уже был защищён
  // таймаутом (2500мс выше), но load() ниже НЕ БЫЛ — а он стоит прямо в
  // критическом пути загрузки (main.js: Platform.init().then(...
  // Platform.load().then(... showMenu(); Platform.ready() ...))). Если
  // init() успевает за 2.5с (доступность моста подтверждена), а
  // ПОСЛЕДУЮЩИЙ VKWebAppStorageGet виснет молча (не реджектится, просто не
  // резолвится — на Android воспроизводимо чаще, чем на десктопе, судя по
  // докладу), showMenu()/Platform.ready() НИКОГДА не вызываются — игрок
  // навсегда на #loading, а сама площадка ВК в итоге показывает свою
  // ошибку загрузки, не дождавшись готовности. Тот же withTimeout(), что
  // уже используется ниже в showRewarded() этого же файла.
  var STORAGE_TIMEOUT_MS = 5000;

  // ТЗ №57: сейв не прочитался (ошибка/таймаут StorageGet, битый JSON) —
  // load() отдаёт null, как и для нового игрока; флаг отличает одно от
  // другого для аналитики (game_loaded.new_player = -1). На игру не влияет.
  var _loadFailed = false;
  function loadFailed() { return _loadFailed; }

  // F01: фоновое повторное чтение. Успех — запись разблокируется; если в
  // облаке есть прогресс, его отдаём игре (setRecoveryHandler) — она
  // перезагрузится в безопасный момент, а накопленное за время сбоя
  // состояние сессии отбрасывается: прежний прогресс важнее.
  var VK_LOAD_RETRY_BASE_MS = 5000;
  var VK_LOAD_RETRY_MAX_MS  = 120000;
  var _loadRetryAttempt = 0;
  var _recoveryHandler = null;
  function setRecoveryHandler(fn) { _recoveryHandler = fn; }

  function vkScheduleLoadRetry() {
    var delay = Math.min(VK_LOAD_RETRY_MAX_MS, VK_LOAD_RETRY_BASE_MS * Math.pow(2, _loadRetryAttempt));
    _loadRetryAttempt++;
    setTimeout(vkRetryLoad, delay);
  }

  function vkRetryLoad() {
    withTimeout(vkBridge.send('VKWebAppStorageGet', { keys: [STORAGE_KEY] }), STORAGE_TIMEOUT_MS)
      .then(function (res) {
        var raw = res.keys && res.keys[0] && res.keys[0].value;
        var data = raw ? JSON.parse(raw) : null;
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          // Прогресс в облаке есть, игра о нём не знает — запись остаётся
          // заблокированной, пока игра не перезагрузится и не прочтёт его.
          if (_recoveryHandler) _recoveryHandler(data);
          return;
        }
        _saveBlocked = false; // в облаке действительно пусто — терять нечего
        _retryAttempt = 0;
        if (_pendingState != null) vkFlushNow();
      })
      .catch(function (e) {
        console.warn('[Platform] повторное чтение сейва не удалось:', e);
        vkScheduleLoadRetry();
      });
  }

  function load() {
    if (!available) {
      try {
        var raw = localStorage.getItem(DEV_SAVE_KEY);
        return Promise.resolve(raw ? JSON.parse(raw) : null);
      } catch (e) { return Promise.resolve(null); }
    }
    return withTimeout(vkBridge.send('VKWebAppStorageGet', { keys: [STORAGE_KEY] }), STORAGE_TIMEOUT_MS)
      .then(function (res) {
        var raw = res.keys && res.keys[0] && res.keys[0].value;
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          // Облако ответило, но значение не JSON (обрезано/испорчено):
          // повтор не поможет. Кладём копию рядом, прежде чем игра
          // перепишет ключ, — данные не пропадают безвозвратно.
          console.error('[Platform] сейв в облаке не разбирается как JSON — копия в ' + STORAGE_KEY + '_corrupt:', e);
          _loadFailed = true;
          try {
            vkBridge.send('VKWebAppStorageSet', { key: STORAGE_KEY + '_corrupt', value: String(raw) })
              .catch(function () {});
          } catch (e2) { /* копия — по возможности */ }
          return null;
        }
      })
      .catch(function (e) {
        console.error('[Platform] StorageGet ошибка/таймаут (' + STORAGE_TIMEOUT_MS + 'мс) — запись сейва заблокирована до успешного чтения:', e);
        _loadFailed = true;
        _saveBlocked = true;
        vkScheduleLoadRetry();
        return null;
      });
  }

  // ТЗ №01, п.3.1: по образцу яндексовского platform.js. На платформе —
  // ВСЕГДА реальные часы устройства (?fakeDate игнорируется, даже если
  // случайно окажется в URL хостинга — available=true на боевом ВК, эту
  // ветку игрок обойти не может). Вне платформы (dev/приёмка) допускаем
  // ?fakeDate=YYYY-MM-DD в query — без этого нельзя проверить серию
  // входов/раздатчик за один присест, не дожидаясь реальной полуночи.
  function now() {
    if (available) return new Date();
    try {
      var params = new URLSearchParams(window.location.search);
      var fake = params.get('fakeDate');
      if (fake && /^\d{4}-\d{2}-\d{2}$/.test(fake)) {
        var p = fake.split('-');
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        if (!isNaN(d.getTime())) return d;
      }
    } catch (e) { /* падать нельзя */ }
    return new Date();
  }

  /* ---------------------------------------------------------------
     ТЗ №09/№10/№53 — сти́ки-баннер (VKWebAppShowBannerAd). Параметры
     сверены с докой базы «Баннерная реклама для VK» (VK_banner_doc_dlya_CC.md,
     передана советом дословно). ТЗ №10: живой заход основателя показал,
     что overlay накрывает карточки категорий — 'overlay' по смыслу и
     означает «поверх».
     ТЗ №53 (2026-09-15), ФАКТ по живому ВК: до ТЗ №10 (v23, 'overlay')
     основатель баннер на десктопе ВИДЕЛ (он накрывал карточки — ровно
     то, что чинило ТЗ №10). После перехода на layout_type:'resize'
     (введён ТЗ №10 как шаг A) баннера на десктопе не стало — resize
     для десктопа в доке не описан (только для мобильного приложения) и
     на практике не сработал. Поэтому десктоп ВОЗВРАЩЁН на
     документированный набор — 'overlay'/'right'/'vertical', ровно как в
     таблице «Десктопная версия сайта». Собственный резерв места (шаг B
     ниже) не зависит от факта resize и решает «баннер не накрывает
     контент» без него — остаётся как есть. Диагностика (см. showBannerAd
     ниже) — чтобы следующий живой заход основателя дал точный ответ,
     если баннер снова не появится.
       Шаг A — десктоп: см. факт выше.
       Шаг B — ГАРАНТИРОВАННЫЙ, не зависит от того, послушал ли VK шаг A:
         остаёмся на факте (баннер может визуально оставаться overlay),
         но САМИ резервируем место игровому контейнеру по РЕАЛЬНЫМ
         размерам баннера (VKWebAppCheckBannerAd при старте +
         VKWebAppBannerAdUpdated на изменения) через CSS-переменные
         --vk-banner-reserve-right/--vk-banner-reserve-bottom (style.css,
         #app). Портретная колонка сама центрируется в оставшейся ширине
         (#app padding сдвигает containing block у .screen{inset:0} —
         правки в main.js/screen-разметке не нужны).
     Платформа читается из launch-параметра vk_platform (та же техника,
     что getLang() уже использует для vk_language из URL). desktop_web/
     desktop_app -> десктоп, всё остальное -> мобайл.

     ЧЕСТНО (как и в ТЗ №09 про сам вид баннера): точная схема полей
     VKWebAppCheckBannerAd/VKWebAppBannerAdUpdated (какими именами приходит
     ширина/высота) не подтверждена ни одной локальной докой — dev.vk.com
     недоступен из этой сети. extractBannerSize() ниже читает несколько
     правдоподобных имён полей и, если ни одно не подошло, откатывается на
     задокументированный запасной размер (с запасом, чтобы не воспроизвести
     тот же баг — лучше зарезервировать чуть больше места, чем перекрыть
     карточки повторно). Живая проверка реальных значений — на основателе.
     --------------------------------------------------------------- */
  var _bannerClosedByUser = false; // сброс каждой загрузкой страницы — «до следующей сессии»
  var BANNER_FALLBACK_WIDTH_PX  = 300; // десктоп, вертикальный баннер — не подтверждено докой, запас
  var BANNER_FALLBACK_HEIGHT_PX = 90;  // мобайл, нижний баннер — не подтверждено докой, запас

  // ТЗ №11, Фаза 1 — ОДИН механизм резервирования, не два. Диагноз ТЗ №11,
  // п.0: если ВК фактически применил layout_type:'resize' (сам ужал
  // видимую область страницы под баннер), а мы поверх этого ЕЩЁ добавляем
  // свой CSS-отступ (Шаг B из ТЗ №10) — место резервируется дважды: колонка
  // сдвинута, справа мёртвая зона, скроллбар не у края.
  //
  // Bridge не подтверждает докой, применил ли он resize (см. честный
  // комментарий про extractBannerSize ниже) — единственный проверяемый на
  // живом ВК факт: реально ли сузилось окно. Поэтому режим определяем по
  // факту (сравнение размера окна до/после показа баннера), а не по тому,
  // что мы попросили в params.
  //
  // _platformReservesSpace=true — площадка сама сузила окно; наш отступ
  // ВЫКЛЮЧЕН полностью (и Updated-события его больше не включают, пока
  // баннер жив). false — площадка не резервирует сама (overlay по факту
  // или resize проигнорирован) — работает только наш отступ, как в ТЗ №10.
  var _platformReservesSpace = false;
  var PLATFORM_RESIZE_THRESHOLD_PX = 40; // фильтр шума измерения, заведомо меньше реального баннера
  var VIEWPORT_SETTLE_MS = 400; // нет докой подтверждённого тайминга — щедрый, но ограниченный бюджет

  function isDesktopPlatform() {
    try {
      var p = (new URLSearchParams(location.search)).get('vk_platform') || '';
      return p === 'desktop_web' || p === 'desktop_app';
    } catch (e) { return false; }
  }

  // Резервирует контейнеру место под баннер (Шаг B). px=0 — снять резерв
  // (баннер закрыт/скрыт). Одна CSS-переменная активна за раз: десктоп
  // резервирует справа, мобайл — снизу (по той же isDesktopPlatform(),
  // что решает раскладку показа).
  function applyBannerReserve(px) {
    var varName = isDesktopPlatform() ? '--vk-banner-reserve-right' : '--vk-banner-reserve-bottom';
    document.documentElement.style.setProperty(varName, Math.max(0, px | 0) + 'px');
  }

  // Ждёт, пока окно фактически изменит размер (событие resize) либо истечёт
  // короткий settle-таймаут, затем один раз сообщает актуальный размер.
  // Нужно, чтобы дать площадке время реально применить layout_type:'resize',
  // если она это делает — иначе решение "резервировать самим или нет"
  // принимается раньше, чем платформа успела ужать окно.
  function waitForViewportSettle(desktop, cb) {
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      window.removeEventListener('resize', onResize);
      cb(desktop ? window.innerWidth : window.innerHeight);
    }
    function onResize() { finish(); }
    window.addEventListener('resize', onResize);
    setTimeout(finish, VIEWPORT_SETTLE_MS);
  }

  // Читает ширину/высоту из ответа VKWebAppCheckBannerAd или данных
  // события VKWebAppBannerAdUpdated — схема полей не подтверждена докой
  // (см. заголовок блока), поэтому перебираем правдоподобные варианты
  // вместо одного жёстко зашитого имени.
  function extractBannerSize(payload) {
    if (!payload) return null;
    var w = payload.width != null ? payload.width
      : (payload.banner_width != null ? payload.banner_width
      : (payload.size && payload.size.width != null ? payload.size.width : null));
    var h = payload.height != null ? payload.height
      : (payload.banner_height != null ? payload.banner_height
      : (payload.size && payload.size.height != null ? payload.size.height : null));
    if (w == null && h == null) return null;
    return { width: w, height: h };
  }

  // ТЗ №53, п.3.2: мост иногда не готов сразу после init — если
  // VKWebAppShowBannerAd реджектится, ОДНА повторная попытка через 3с с
  // теми же параметрами, не больше (isRetry — не пускает вторую). После
  // VKWebAppBannerAdClosedByUser повторов нет (_bannerClosedByUser — как
  // и раньше не пускает showBannerAd() вообще, см. первую строку).
  var BANNER_RETRY_DELAY_MS = 3000;

  function jsonForLog(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  // 2026-09-25, решение основателя: на ПК-версии ВК баннера сбоку НЕТ —
  // не запрашиваем его вовсе (и резерв места справа не ставим). Мобильный
  // нижний баннер — как был. Код десктопного показа ниже оставлен на
  // случай возврата: снять этот флаг.
  var DESKTOP_BANNER_ENABLED = false;

  function showBannerAd(isRetry) {
    if (!available || _bannerClosedByUser) return;
    var desktop = isDesktopPlatform();
    if (desktop && !DESKTOP_BANNER_ENABLED) {
      if (window.debugLog) window.debugLog('showBannerAd: ПК — баннер выключен (решение основателя 25.09)');
      return;
    }
    var beforeSize = desktop ? window.innerWidth : window.innerHeight;
    var params = desktop
      ? { layout_type: 'overlay', banner_align: 'right', orientation: 'vertical' } // Шаг A (ТЗ №53: overlay, документированный набор)
      : { banner_location: 'bottom' };
    // Показ — тихий: ошибка/недоступность не блокирует и не ломает игру
    // (вне платформы — no-op через available выше; внутри платформы —
    // просто нет баннера, что уже фактически "не мешает").
    if (window.debugLog) window.debugLog('showBannerAd' + (isRetry ? ' (повтор)' : '') + ': params=' + jsonForLog(params));
    vkBridge.send('VKWebAppShowBannerAd', params)
      .then(function (res) {
        if (window.debugLog) window.debugLog('showBannerAd: мост ОТВЕТИЛ (успех) res=' + jsonForLog(res));
        // Оптимистично, СРАЗУ по запасному размеру (ТЗ №10, шаг B) — не
        // ждём подтверждения факта resize, чтобы не было окна, где баннер
        // уже показан, а карточки ещё не подвинуты (тот самый баг ТЗ №10).
        // Считаем overlay безопасным дефолтом; если ниже выяснится, что
        // площадка сама ужала окно, — отступ будет снят (ТЗ №11, Фаза 1).
        _platformReservesSpace = false;
        applyBannerReserve(desktop ? BANNER_FALLBACK_WIDTH_PX : BANNER_FALLBACK_HEIGHT_PX);
        // VKWebAppCheckBannerAd при старте (ТЗ №10, шаг B) — уточняет
        // резерв реальным размером, если Bridge его отдаёт.
        vkBridge.send('VKWebAppCheckBannerAd').then(function (res) {
          if (window.debugLog) window.debugLog('CheckBannerAd: res=' + jsonForLog(res));
          if (_platformReservesSpace) return; // площадка уже подтверждена — не перетираем 0
          var size = extractBannerSize(res);
          if (size) applyBannerReserve(desktop ? size.width : size.height);
        }).catch(function (e) {
          if (window.debugLog) window.debugLog('CheckBannerAd: ошибка ' + jsonForLog(e) + ' — остаёмся на запасном размере');
        });

        // Параллельно — ТЗ №11, Фаза 1: проверяем ФАКТ (сравнение размера
        // окна до/после показа баннера), не ужала ли площадка окно сама.
        // Если да — наш отступ ОБЯЗАН быть снят, иначе получится двойное
        // резервирование (диагноз ТЗ №11, п.0). Решение окончательное —
        // применяется поверх любого значения, выставленного выше.
        waitForViewportSettle(desktop, function (afterSize) {
          var shrinkPx = beforeSize - afterSize;
          _platformReservesSpace = shrinkPx >= PLATFORM_RESIZE_THRESHOLD_PX;
          if (_platformReservesSpace) {
            applyBannerReserve(0);
            console.log('[Platform] баннер: площадка сама ужала окно (' +
              beforeSize + 'px -> ' + afterSize + 'px), свой отступ выключен.');
          }
          if (window.debugLog) {
            window.debugLog('сужение: ' + beforeSize + '->' + afterSize + 'px, резерв=' +
              (_platformReservesSpace ? 'площадки' : 'свой'));
          }
        });
      })
      .catch(function (e) {
        console.warn('[Platform] баннер недоступен:', e);
        if (window.debugLog) window.debugLog('showBannerAd: мост ОТВЕТИЛ ошибкой/недоступен: ' + jsonForLog(e));
        if (!isRetry) {
          setTimeout(function () { showBannerAd(true); }, BANNER_RETRY_DELAY_MS);
        }
      });
  }

  if (hasBridge() && vkBridge.subscribe) {
    vkBridge.subscribe(function (e) {
      if (!e || !e.detail) return;
      // VKWebAppBannerAdClosedByUser — игрок сам закрыл баннер крестиком;
      // больше не переоткрываем эту сессию (уважение + меньше жалоб) и
      // снимаем резерв — раскладка возвращается (ТЗ №10, шаг B). Если до
      // этого резервировала площадка сама (Фаза 1 ТЗ №11) — applyBannerReserve(0)
      // здесь безопасный no-op (мы и так ничего не резервировали).
      if (e.detail.type === 'VKWebAppBannerAdClosedByUser') {
        _bannerClosedByUser = true;
        _platformReservesSpace = false;
        applyBannerReserve(0);
      }
      // VKWebAppBannerAdUpdated — уточняем резерв реальным размером
      // (ТЗ №10, шаг B). ТЗ №11: если площадка резервирует место сама —
      // НЕ дублируем её отступ своим, иначе снова двойное резервирование.
      // Молчим, если размер не распознан — остаёмся на том, что уже
      // выставлено (запасной или предыдущий реальный).
      if (e.detail.type === 'VKWebAppBannerAdUpdated') {
        if (_platformReservesSpace) return;
        var size = extractBannerSize(e.detail.data);
        if (size) applyBannerReserve(isDesktopPlatform() ? size.width : size.height);
      }
    });
  }

  // 2026-09-07 (аудит по запросу координатора, тот же класс бага, что
  // showRewarded/load() уже чинили раньше): молчащий мост здесь оставлял
  // бы игру на паузе НАВСЕГДА — main.js::maybeShowInterstitial ставит
  // Nonogram.setPaused(true) ДО вызова, снимает только в колбэке onDone.
  // Найдено при аудите пути загрузки (ТЗ №47), не на самом пути загрузки —
  // но риск идентичен, чинится тем же приёмом.
  var INTERSTITIAL_TIMEOUT_MS = 15000;

  // Полноэкранная реклама. onDone(shown) зовём в любом исходе; shown — true,
  // только если площадка подтвердила показ (result:true) — для аналитики
  // (ТЗ №57, interstitial_shown), на ход игры не влияет.
  function showInterstitial(onDone) {
    var finished = false;
    function done(shown) { if (!finished) { finished = true; if (onDone) onDone(!!shown); } }

    if (!available) { done(false); return; }
    vkFlushNow(); // событие «перед рекламой» — не ждём дебаунса
    var sent = vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'interstitial' });
    // v67: промис моста может остаться без ответа и после нашего таймаута
    // (vk-bridge#615) — помечаем, чтобы строка кода неудачного бонуса это
    // показала («межстр. висит»).
    _interPending++;
    var unpend = function () { _interPending--; };
    Promise.resolve(sent).then(unpend, unpend);
    withTimeout(sent, INTERSTITIAL_TIMEOUT_MS)
      .then(function (res) { done(!!res && res.result === true); })
      .catch(function (e) { console.warn('[Platform] interstitial недоступен/не ответил:', e); done(false); });
  }
  var _interPending = 0;

  /* ---------- Диагностика неудачного бонуса (v67) ----------
     Жалоба основателя 05.10: в мобильном приложении ВК реклама за
     подсказку «грузится, потом — отключите блокировщик», хотя блокировщика
     нет. Игроку и в Метрику уходило только слово error — настоящий ответ
     моста (error_type / error_code / error_reason) видела лишь консоль, а
     на телефоне её не открыть. Теперь неудачный показ несёт diag: что
     именно ответил мост, через сколько, какая версия приложения ВК.
     main.js выводит короткую строку кода в уведомлении и шлёт ключ в
     rewarded_result.err. Тот же формат — в game1 (b56) и game3. */
  var _clientVer = ''; // 'android 8.12' — VKWebAppGetClientVersion, фоном после init
  function fetchClientVersion() {
    var p;
    try { p = vkBridge.send('VKWebAppGetClientVersion'); } catch (e) { return; }
    Promise.resolve(p).then(function (r) {
      if (r && (r.platform || r.version)) _clientVer = String(r.platform || '?') + ' ' + String(r.version || '?');
    }, function () {});
  }
  function launchPlatform() {
    try { return (new URLSearchParams(location.search)).get('vk_platform') || ''; } catch (e) { return ''; }
  }
  // Отказ моста ВК: { error_type, error_data: { error_code, error_reason } };
  // error_reason бывает строкой или объектом { error_msg }.
  function bridgeErr(e) {
    var type = '', code = '', reason = '';
    if (e && typeof e === 'object') {
      if (e instanceof Error) reason = e.message;
      type = e.error_type ? String(e.error_type) : '';
      var d = (e.error_data && typeof e.error_data === 'object') ? e.error_data : e;
      if (d.error_code != null) code = String(d.error_code);
      var r = d.error_reason != null ? d.error_reason : (d.error_description || d.error_msg || '');
      if (r && typeof r === 'object') r = r.error_msg || r.error_description || JSON.stringify(r);
      if (r) reason = String(r);
    } else if (e != null) {
      reason = String(e);
    }
    reason = reason.replace(/\s+/g, ' ').trim().slice(0, 48);
    return { type: type, code: code, reason: reason, short: (type ? ':' + type : '') + (code ? ':' + code : '') };
  }
  // reason — исход showBonusAd ('error' | 'timeout' | 'refused' | 'unavailable').
  function adDiag(reason, startedAt, err) {
    var sec = startedAt ? Math.round((Date.now() - startedAt) / 100) / 10 : 0;
    var be = reason === 'error' ? bridgeErr(err) : { type: '', code: '', reason: '', short: '' };
    // key — для Метрики: короткий и стабильный, как в game1
    // ('error:client_error:1', 'timeout', 'no_result', 'unavailable').
    var key = reason === 'error' ? 'error' + be.short : (reason === 'refused' ? 'no_result' : reason);
    var what = reason === 'error'
      ? ['ВК', be.type, be.code, be.reason ? '«' + be.reason + '»' : ''].filter(Boolean).join(' ')
      : (reason === 'timeout' ? 'ВК молчит' : (reason === 'refused' ? 'ВК: result ≠ true' : 'нет моста ВК'));
    var plat = launchPlatform();
    var text = [what, sec + ' с', _interPending > 0 ? 'межстр. висит' : '', _clientVer || plat]
      .filter(Boolean).join(' · ');
    // app — нативное приложение ВК (не браузер): блокировщика там не бывает
    var app = /^(mobile_(android|iphone|ipad)|android_|iphone_|ipad_)/.test(plat);
    return { res: reason, type: be.type, code: be.code, reason: be.reason, sec: sec, cv: _clientVer, app: app, key: key, text: text };
  }

  // Гонка настоящего промиса моста против таймера — settle-once семантика
  // промиса сама даёт идемпотентность (эталон game3/color_sort/vk_platform.js).
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  // Бонус «за рекламу» (подсказка, «Проверить», открыть главу). Раунд 2
  // (решение основателя 2026-10-01): РЕКЛАМА ЗА ВОЗНАГРАЖДЕНИЕ (rewarded) —
  // правила ВК/Яндекса не дают показывать interstitial по кнопке игрока
  // (ВК: interstitial «только в момент перехода между экранами»). Раунд 1
  // (interstitial) отключён флагом BONUS_AD_FORMAT, путь сохранён.
  // onResult(shown, reason) зовётся ровно один раз. shown === true ТОЛЬКО
  // если площадка подтвердила показ/просмотр (result:true). Любой другой
  // исход — нет моста/не VK-окружение, adblock, отказ, пустой результат,
  // таймаут — shown === false и бонус НЕ выдаётся: прежнее «ошибка =
  // бесплатно» (студийный стандарт п.190) отменено 2026-10-01 и не
  // возвращается.
  // reason: 'shown' | 'unavailable' | 'refused' (result:false) |
  // 'error' (мост ответил ошибкой — в т.ч. adblock) | 'timeout'.
  // Третий аргумент — diag (v67, см. adDiag) при неудаче, null при показе.
  var BONUS_AD_FORMAT = 'reward';  // 'reward' | 'interstitial'
  var BONUS_AD_TIMEOUT_MS = 40000; // ролик до 30 с + загрузка; молчащий мост бонус не даёт
  var _bonusAdInFlight = false;
  // Аудит 2026-10-05, F02: ответ SDK мог прийти ПОСЛЕ таймаута (медленная
  // загрузка ролика) — result:true терялся, хотя игрок рекламу посмотрел.
  // Таймер по-прежнему возвращает управление (done(false,'timeout')), но
  // настоящий промис моста не отбрасывается: поздний result:true вызывает
  // onLate() — ровно один раз на запрос. Что выдать за позднюю награду,
  // решает вызывающий (main.js: баланс подсказок / открытие главы), а не
  // действие над текущим полем — к уже ушедшей вперёд игре оно не липнет.
  function showBonusAd(onResult, onLate) {
    var finished = false;
    var lateDone = false;
    var timer = null;
    var startedAt = 0;
    // v67: третий аргумент onResult — diag (adDiag выше) при любом неудачном
    // исходе; при shown === true — null.
    function done(shown, reason, err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      _bonusAdInFlight = false;
      var diag = shown ? null : adDiag(reason, startedAt, err);
      if (window.debugLog) {
        window.debugLog('showBonusAd: ИТОГ shown=' + shown + ' (' + reason + ')' +
          (diag ? ' — ' + diag.text : ''), { big: true });
      }
      if (onResult) onResult(!!shown, reason, diag);
    }
    if (!available || !hasBridge()) { done(false, 'unavailable'); return; }
    if (_bonusAdInFlight) {
      if (window.debugLog) window.debugLog('showBonusAd: запрос уже в полёте — повторный вызов проигнорирован');
      return;
    }
    _bonusAdInFlight = true;
    startedAt = Date.now();
    vkFlushNow(); // событие «перед рекламой» — не ждём дебаунса
    // v67: только ad_format. Прежний useWaterfall:true мост не читал вовсе —
    // параметр у VKWebAppShowNativeAds называется use_waterfall (snake_case)
    // и по умолчанию и так true. Минимальный запрос — как в документации.
    var params = { ad_format: BONUS_AD_FORMAT };
    timer = setTimeout(function () {
      console.warn('[Platform] showBonusAd (vk): мост не ответил за ' + BONUS_AD_TIMEOUT_MS + 'мс — бонус не выдан (поздний result:true ещё принимается)');
      done(false, 'timeout');
    }, BONUS_AD_TIMEOUT_MS);
    var sent;
    try { sent = vkBridge.send('VKWebAppShowNativeAds', params); }
    catch (e) { sent = Promise.reject(e); }
    sent.then(function (res) {
      var ok = !!res && res.result === true;
      if (finished) {
        if (ok && !lateDone) {
          lateDone = true;
          if (window.debugLog) window.debugLog('showBonusAd: ПОЗДНЯЯ награда после таймаута принята', { big: true });
          if (onLate) onLate();
          vkFlushNow();
        }
        return;
      }
      // Выдача обязана пережить немедленное закрытие/перезагрузку сразу
      // после ролика (ТЗ №12) — saveProgress() внутри onResult лишь ставит
      // запись в очередь дебаунса; флаш делает ВЫЗЫВАЮЩИЙ после выдачи.
      done(ok, ok ? 'shown' : 'refused');
      if (ok) vkFlushNow();
    }, function (e) {
      if (finished) return;
      console.warn('[Platform] showBonusAd (vk): площадка отказала — бонус не выдан:', e);
      done(false, 'error', e);
    });
  }

  /* ---------- Шеринг картинки в историю (ТЗ №51) ----------
     Контракт общий с platform.js (Яндекс): canShareStory()/shareStory(dataUrl)
     существуют на ОБЕИХ площадках (main.js вызывает canShareStory()
     безусловно, без typeof-гарда) — на Яндексе canShareStory() всегда
     false, кнопка #btn-share остаётся hidden. supports-гард — тот же
     приём, что уже используется у track() выше в этом файле. */
  function canShareStory() {
    return available && hasBridge() && typeof vkBridge.supports === 'function' &&
      vkBridge.supports('VKWebAppShowStoryBox');
  }

  // Возвращает Promise<boolean> — true только при подтверждённой публикации;
  // все ошибки (в т.ч. отмена показа самим игроком) глотаются здесь и
  // превращаются в false, main.js по true показывает тост «Опубликовано»,
  // по false — молчит (отмена не должна выглядеть как сбой).
  function shareStory(dataUrl) {
    if (!available || !hasBridge()) return Promise.resolve(false);
    try {
      return vkBridge.send('VKWebAppShowStoryBox', {
        background_type: 'image',
        blob: dataUrl,
        attachment: { text: 'open', type: 'url', url: 'https://vk.com/app54676906' },
      }).then(function () {
        return true;
      }).catch(function (e) {
        console.warn('[Platform] shareStory ошибка/отказ (в т.ч. отмена пользователем):', e);
        return false;
      });
    } catch (e) {
      console.error('[Platform] shareStory бросил:', e);
      return Promise.resolve(false);
    }
  }

  // Покупки за голоса (ЗАДАЧА N, п. «покупки — не делать в этой задаче»):
  // VKWebAppShowOrderBox по официальной механике требует серверный
  // колбэк-скрипт («Адрес обратного вызова» в настройках приложения VK),
  // которого у студии нет. Реализовывать самодельный обход — запрещено
  // постановкой. Контракт остаётся полным (main.js одинаков для обеих
  // сборок и вызывает эти методы безусловно), но всегда отвечает «ничего
  // нет»/«отменено»: getCatalog() возвращает пустой каталог.
  //
  // ТЗ №07, фаза 3.3: раньше это приводило к тому, что main.js показывал
  // каждый платный товар как shopUnavailable с задизейбленной кнопкой
  // «Купить» — витрина видна, купить нельзя. По стандарту студии (18.08,
  // второй отказ Color Sort ВК за такую же витрину) это состояние обязано
  // быть НЕВЫРАЗИМЫМ. paymentsAvailable:false — флаг, по которому main.js
  // (showShop) целиком скрывает платные ряды в ВК-сборке, а не просто
  // дизейблит кнопку. Код покупок не удалён — если ВК-платежи когда-нибудь
  // подключат, здесь меняется одно значение.
  // getPurchases() — контракт {ok, purchases, error} общий с platform.js
  // (ТЗ №18, refreshCosmeticOwnership вызывается безусловно на каждом
  // старте для обеих сборок). ok:true/purchases:[] здесь — не сбой, а то
  // же «покупок нет», что и в dev-режиме Яндекса: платежи на ВК выключены
  // флагом (paymentsAvailable:false), а не упавшим вызовом.
  function getCatalog()                { return Promise.resolve([]); }
  function getPurchases()               { return Promise.resolve({ ok: true, purchases: [] }); }
  function purchase(productId)          { return Promise.resolve(null); }
  function consumePurchase(purchaseToken) { return Promise.resolve(); }

  /* ---------- КРЮЧКИ ПЛОЩАДКИ (ТЗ №49, п.5) ----------
     Контракт общий с platform.js (Яндекс) — main.js вызывает эти методы
     безусловно на обеих сборках. Fire-and-forget: try/catch + .catch,
     никогда не бросают и не блокируют игру; без моста (dev-режим) —
     тихий no-op. */

  function promptAddToFavorites() {
    if (!available) return;
    try {
      vkBridge.send('VKWebAppAddToFavorites').catch(function (e) {
        console.warn('[Platform] AddToFavorites ошибка/отказ:', e);
      });
    } catch (e) {
      console.error('[Platform] promptAddToFavorites бросил:', e);
    }
  }

  function promptRecommend() {
    if (!available) return;
    try {
      vkBridge.send('VKWebAppRecommend').catch(function (e) {
        console.warn('[Platform] Recommend ошибка/отказ:', e);
      });
    } catch (e) {
      console.error('[Platform] promptRecommend бросил:', e);
    }
  }

  // У VK Bridge нет аналога API «ярлык на экран»/«запросить отзыв» Яндекс
  // Игр — no-op, симметрично тому, как platform.js (Яндекс) не умеет
  // AddToFavorites/Recommend.
  function promptShortcut() {}
  function requestReview()  {}
  function gameplayStart()  {}
  function gameplayStop()   {}

  // VKWebAppSendCustomEvent — аналитическое событие ВК. Схема полей
  // (event/screen/type/json/timezone) сверена с постановкой ТЗ №49
  // («параметры по документации dev.vk.com»), но НЕ подтверждена самой
  // докой — dev.vk.com недоступен из этой сети (та же оговорка, что уже
  // была честно сделана про схему VKWebAppCheckBannerAd/Updated выше в
  // этом файле). vkBridge.supports-гард — единственная защита от вызова
  // на клиентах, где метода нет; при неверной схеме полей площадка молча
  // отклонит событие (аналитика необязательна, игру не ломает).
  // ТЗ №54: тактильный отклик. kind: 'light' (линия закрыта) | 'success'
  // (картинка собрана). Методы — из таблицы VK Bridge в docs/ студии
  // («Документация к играм на VK»). Где моста/метода нет (веб-версия ВК в
  // браузере) — navigator.vibrate на Android; iOS-Safari его не знает, молча.
  function haptic(kind) {
    try {
      if (available && hasBridge() && typeof vkBridge.supports === 'function') {
        if (kind === 'success' && vkBridge.supports('VKWebAppTapticNotificationOccurred')) {
          vkBridge.send('VKWebAppTapticNotificationOccurred', { type: 'success' }).catch(function () {});
          return;
        }
        if (kind !== 'success' && vkBridge.supports('VKWebAppTapticImpactOccurred')) {
          vkBridge.send('VKWebAppTapticImpactOccurred', { style: 'light' }).catch(function () {});
          return;
        }
      }
      if (navigator.vibrate) navigator.vibrate(kind === 'success' ? [30, 60, 30] : 12);
    } catch (e) { /* вибрация необязательна */ }
  }

  function track(name, params) {
    if (!available || !hasBridge() || typeof vkBridge.supports !== 'function') return;
    try {
      if (!vkBridge.supports('VKWebAppSendCustomEvent')) return;
      vkBridge.send('VKWebAppSendCustomEvent', {
        event: name,
        screen: 'game',
        type: 'game',
        json: JSON.stringify(params || {}),
        timezone: -(new Date().getTimezoneOffset()),
      }).catch(function (e) {
        console.warn('[Platform] track(' + name + ') ошибка/отказ:', e);
      });
    } catch (e) {
      console.error('[Platform] track бросил:', e);
    }
  }

  return {
    init: init,
    ready: ready,
    getLang: getLang,
    isAvailable: isAvailable,
    save: save,
    load: load,
    loadFailed: loadFailed,
    setRecoveryHandler: setRecoveryHandler,
    now: now,
    showBannerAd: showBannerAd,
    showInterstitial: showInterstitial,
    showBonusAd: showBonusAd,
    canShareStory: canShareStory,
    shareStory: shareStory,
    getCatalog: getCatalog,
    getPurchases: getPurchases,
    purchase: purchase,
    consumePurchase: consumePurchase,
    promptAddToFavorites: promptAddToFavorites,
    promptRecommend: promptRecommend,
    promptShortcut: promptShortcut,
    requestReview: requestReview,
    gameplayStart: gameplayStart,
    gameplayStop: gameplayStop,
    track: track,
    haptic: haptic,
    paymentsAvailable: false,
    SAVE_SIZE_GUARD_BYTES: VK_SAVE_SIZE_GUARD_BYTES,
  };
})();
}

// Экспорт для юнит-тестов (Node, без window/vkBridge) — сама функция
// вытеснения/торможения чистая и не нуждается в браузерном окружении.
if (typeof module === 'object' && module.exports) {
  module.exports = {
    computeDebounceDelay: vkComputeDebounceDelay,
    shouldSendNow:        vkShouldSendNow,
    pruneWriteLog:        vkPruneWriteLog,
    SAVE_DEBOUNCE_MS:     VK_SAVE_DEBOUNCE_MS,
    WRITE_LIMIT_PER_HOUR: VK_WRITE_LIMIT_PER_HOUR,
    SOFT_BRAKE_THRESHOLD: VK_SOFT_BRAKE_THRESHOLD,
    MAX_DEBOUNCE_MS:      VK_MAX_DEBOUNCE_MS,
    SAVE_SIZE_GUARD_BYTES: VK_SAVE_SIZE_GUARD_BYTES,
  };
}
