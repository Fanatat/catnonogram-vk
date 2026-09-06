/* ============================================================
   adapters/vk_bridge.js — нативный @vkontakte/vk-bridge (v3.0.2, вшит
   локально как vk-bridge.min.js, без CDN).
   Подставляется build.py как platform.js в vk-сборку.

   Публичный интерфейс 1:1 повторяет боевой platform.js (Яндекс),
   промодерированный и не подлежащий изменению: init, ready, getLang,
   isAvailable, save, load, now, showInterstitial(onDone),
   showRewarded(onReward, onClose). Это НЕ «канонiчный контракт v2» из
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
  // ТЗ №23 v2: молчащий мост (ни .then, ни .catch за showRewarded) оставлял
  // игрока перед замороженным экраном — onHintClick ставит паузу ДО вызова
  // и снимает её только в колбэке. Значение — эталон game3/color_sort/
  // vk_platform.js REWARD_AD_TIMEOUT_MS (число не придумано, Р-Э5).
  var REWARD_AD_TIMEOUT_MS = 40000;

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

  function vkFlushPending() {
    _flushTimer = null;
    if (_pendingState == null) return;
    var toSend = _pendingState;
    _pendingState = null;
    _writeLog = vkPruneWriteLog(_writeLog, Date.now());
    _writeLog.push(Date.now());
    vkBridge.send('VKWebAppStorageSet', {
      key:   STORAGE_KEY,
      value: JSON.stringify(toSend),
    }).catch(function (e) {
      console.error('[Platform] StorageSet ошибка:', e);
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
    if (!_flushTimer) {
      _writeLog = vkPruneWriteLog(_writeLog, Date.now());
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
        return raw ? JSON.parse(raw) : null;
      })
      .catch(function (e) {
        console.error('[Platform] StorageGet ошибка/таймаут (' + STORAGE_TIMEOUT_MS + 'мс):', e);
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
     ТЗ №09/№10 — сти́ки-баннер (VKWebAppShowBannerAd). Параметры сверены
     с докой базы «Баннерная реклама для VK» (VK_banner_doc_dlya_CC.md,
     передана советом дословно). ТЗ №10: живой заход основателя показал,
     что overlay накрывает карточки категорий — 'overlay' по смыслу и
     означает «поверх». Водопад режимов (ТЗ №10, диагноз п.0):
       Шаг A — десктоп: layout_type:'resize' вместо 'overlay' (в доке
         подтверждён только для мобильного приложения; для десктопа
         поддержка НЕ подтверждена первоисточником — заказываем, но не
         полагаемся на него одного).
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

  function showBannerAd() {
    if (!available || _bannerClosedByUser) return;
    var desktop = isDesktopPlatform();
    var beforeSize = desktop ? window.innerWidth : window.innerHeight;
    var params = desktop
      ? { layout_type: 'resize', banner_align: 'right', orientation: 'vertical' } // Шаг A
      : { banner_location: 'bottom' };
    // Показ — тихий: ошибка/недоступность не блокирует и не ломает игру
    // (вне платформы — no-op через available выше; внутри платформы —
    // просто нет баннера, что уже фактически "не мешает").
    vkBridge.send('VKWebAppShowBannerAd', params)
      .then(function () {
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
          if (_platformReservesSpace) return; // площадка уже подтверждена — не перетираем 0
          var size = extractBannerSize(res);
          if (size) applyBannerReserve(desktop ? size.width : size.height);
        }).catch(function () { /* остаёмся на запасном размере */ });

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
        });
      })
      .catch(function (e) {
        console.warn('[Platform] баннер недоступен:', e);
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

  // Полноэкранная реклама. onDone() зовём в любом исходе.
  function showInterstitial(onDone) {
    var finished = false;
    function done() { if (!finished) { finished = true; if (onDone) onDone(); } }

    if (!available) { done(); return; }
    vkFlushNow(); // событие «перед рекламой» — не ждём дебаунса
    vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'interstitial' })
      .then(done)
      .catch(function (e) { console.warn('[Platform] interstitial недоступен:', e); done(); });
  }

  // Реклама за награду. onReward() — выдать награду. onClose() — вернуть
  // звук/состояние (зовём всегда после закрытия).
  // Фикс 7: если проверка показала, что rewarded недоступен (adblock) —
  // ролик вообще не запускаем, награда выдаётся сразу («бесплатный режим»).
  // ТЗ №12: «бесплатный режим» — это ЛЮБОЙ случай, когда мы не можем
  // достоверно показать настоящий ролик, не только adblock. Bridge не
  // инициализирован (!available) и сбой промиса показа (catch) — тот же
  // класс: игрок нажал кнопку, обещавшую награду, и не виноват в том, что
  // площадка не смогла её отработать. Единственная законная причина НЕ
  // выдать — явный result:false внутри успешно РАЗРЕШИВШЕГОСЯ промиса
  // (площадка утверждает: ролик показан, но не досмотрен/закрыт игроком).
  // Гонка настоящего промиса моста против таймера — natural Promise-
  // семантика settle-once сама даёт идемпотентность (эталон
  // game3/color_sort/vk_platform.js withTimeout, тот же приём).
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  function showRewarded(onReward, onClose) {
    // 2026-09-06: раньше здесь стоял ещё !rewardedAvailable — флаг ОДНОГО
    // рывка VKWebAppCheckNativeAds при init() с таймаутом всего 1500мс,
    // кэшированный на всю сессию. Живой баг-репорт с мобильного ВК: если
    // ЭТОТ рывок промахнулся (мобильная сеть медленнее 1500мс, или сам
    // CheckNativeAds на мобильном отвечает иначе, чем на десктопе) —
    // rewardedAvailable=false ЗАСТЫВАЛО на весь сеанс, и КАЖДЫЙ клик после
    // исчерпания бесплатного баланса тихо выдавал подсказку бесплатно, ни
    // разу не пытаясь показать настоящий ролик — дыра в монетизации, не
    // видимая на десктопе (там та же самая проверка случайно проходила).
    // Тот же побочный эффект — checkRewardedAvailable() ещё и подменяла
    // #btn-hint.textContent целиком, стирая значок/бейдж/подпись из
    // index.html (main.js/style.css больше не в курсе этой мутации).
    // Теперь КАЖДЫЙ клик после исчерпания бесплатного баланса — это ОДНА
    // настоящая попытка показать ролик, с собственным честным таймаутом
    // REWARD_AD_TIMEOUT_MS (40с, см. ниже) и тем же бесплатным фолбэком на
    // конкретно ЭТОЙ попытке — тот же студийный стандарт «не наказываем
    // игрока за то, что площадка не смогла отработать», но без риска
    // залипания на «бесплатно навсегда» из-за одного неудачного рывка при
    // загрузке страницы.
    if (!available) {
      if (onReward) onReward();
      if (onClose) onClose(true);
      return;
    }
    vkFlushNow(); // событие «перед рекламой» — не ждём дебаунса
    // 2026-09-06: баг-репорт основателя — на мобильном ВК-клиенте
    // VKWebAppShowNativeAds(reward) реально не показывает ролик (баннер
    // при этом работает нормально — площадка в целом рекламу отдаёт,
    // проблема именно с наполнением rewarded-формата). Известная слабость
    // ВК-платформы: инвентарь rewarded-видео исторически заметно ýже
    // баннерного/интерстишл (см. VKCOM/vk-bridge#243 — тот же класс
    // проблемы у CheckNativeAds, который уже привёл к прошлому фиксу этой
    // сессии). useWaterfall:true — задокументированный официальный
    // параметр ИМЕННО для ad_format:'reward': разрешает площадке
    // подставить interstitial, если настоящего rewarded-ролика нет в
    // наличии, вместо немедленного отказа — увеличивает реальную долю
    // показов, не отменяет и не заменяет предохранитель ниже (он остаётся
    // на случай, если и подставить нечего).
    withTimeout(vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'reward', useWaterfall: true }), REWARD_AD_TIMEOUT_MS)
      .then(function (res) {
        var rewarded = res.result === true;
        if (rewarded && onReward) onReward();
        // Выдача обязана пережить немедленное закрытие/перезагрузку сразу
        // после ролика (ТЗ №12, доклад основателя: «выдача сохранена» была
        // ложью — saveProgress() внутри onReward() лишь ставит запись в
        // обычную 10с-очередь дебаунса адаптера; без форс-флаша здесь она
        // терялась при быстром уходе со страницы).
        if (rewarded) vkFlushNow();
        if (onClose) onClose(rewarded);
      })
      .catch(function (e) {
        // Тот же .catch() ловит и штатный сбой моста, и таймаут-предохранитель
        // (withTimeout реджектит по истечении REWARD_AD_TIMEOUT_MS) — оба
        // исхода по студийному стандарту выдают награду бесплатно.
        //
        // 2026-09-06 (расследование): различаем ДВА разных исхода в самом
        // тексте лога — раньше оба выглядели одинаково "недоступен/таймаут",
        // хотя это РАЗНЫЕ ситуации на стороне площадки:
        //   - e.message === 'timeout' (наш withTimeout) -> нативная сторона
        //     ВООБЩЕ не ответила за 40с — ни успехом, ни error_type. Живая
        //     проверка (tools/investigate_vk_android_bridge.js, реальный
        //     vk-bridge.min.js через мок window.AndroidBridge) подтвердила:
        //     это не наш баг тайминга — жест не протухает, вызов уходит
        //     синхронно, <10мс после клика.
        //   - иначе -> площадка ЯВНО ответила ошибкой (объект с error_type
        //     от самого моста) — сюда попадает и обычный сетевой сбой.
        // Если баг воспроизводится на реальном устройстве — эта строка в
        // консоли прямо говорит, какой из двух случаев произошёл, не
        // требует читать код.
        var isSilentTimeout = e instanceof Error && e.message === 'timeout';
        console.warn(
          '[Platform] showRewarded (vk): ' +
          (isSilentTimeout
            ? 'площадка НЕ ОТВЕТИЛА за ' + REWARD_AD_TIMEOUT_MS + 'мс (ни успех, ни ошибка)'
            : 'площадка явно отказала') +
          ', выдаём бесплатно:', e);
        if (onReward) onReward();
        vkFlushNow();
        if (onClose) onClose(true);
      });
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

  return {
    init: init,
    ready: ready,
    getLang: getLang,
    isAvailable: isAvailable,
    save: save,
    load: load,
    now: now,
    showBannerAd: showBannerAd,
    showInterstitial: showInterstitial,
    showRewarded: showRewarded,
    getCatalog: getCatalog,
    getPurchases: getPurchases,
    purchase: purchase,
    consumePurchase: consumePurchase,
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
    pruneWriteLog:        vkPruneWriteLog,
    SAVE_DEBOUNCE_MS:     VK_SAVE_DEBOUNCE_MS,
    WRITE_LIMIT_PER_HOUR: VK_WRITE_LIMIT_PER_HOUR,
    SOFT_BRAKE_THRESHOLD: VK_SOFT_BRAKE_THRESHOLD,
    MAX_DEBOUNCE_MS:      VK_MAX_DEBOUNCE_MS,
    SAVE_SIZE_GUARD_BYTES: VK_SAVE_SIZE_GUARD_BYTES,
  };
}
