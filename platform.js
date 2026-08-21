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

// 3500 — временный бюджет студии, не подтверждённое требование ВК.
// Долг: положить страницу dev.vk.com в базу и заменить цифру. Реального
// задокументированного лимита ВК на размер значения VKWebAppStorageSet в
// базе знаний нет; вторичные источники называют около 4КБ и сообщают о
// более жёсткой границе для сериализованных объектов — 3500 взято с
// запасом от этой оценки. Единственный источник истины для байтового
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

  var available = false;
  // Фикс 7: реклама на ВК по факту ОТДАЁТСЯ (подтверждено на живом устройстве) —
  // false бывает только при adblock у конкретного игрока. В этом случае кнопка
  // подсказки больше НЕ прячется — остаётся и работает бесплатно (см. showRewarded).
  var rewardedAvailable = true; // оптимистичный дефолт, уточняется в checkRewardedAvailable()
  var HINT_LABEL_AD   = '▶ Открыть клетку'; // обещает ролик — только когда он реально будет
  var HINT_LABEL_FREE = 'Открыть клетку';   // без иконки «плей» — реклама не обещана

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
        checkRewardedAvailable(); // не блокирует init() — фикс 4, см. ниже
        return true;
      })
      .catch(function (err) {
        console.error('[Platform] VKWebAppInit ошибка:', err);
        return false;
      });
  }

  // Фикс 7: проверяем доступность rewarded ТОЛЬКО чтобы решить, платный или
  // бесплатный режим подсказки — кнопку больше не прячем (main.js не трогаем,
  // текст на кнопке правим здесь же). Если ВК начнёт отдавать рекламу —
  // следующая проверка (при следующей загрузке) вернёт true, и кнопка сама
  // вернётся в платный режим, без пересборки билда.
  function checkRewardedAvailable() {
    var timeoutP = new Promise(function (resolve) {
      setTimeout(function () { resolve(false); }, 1500);
    });
    Promise.race([
      vkBridge.send('VKWebAppCheckNativeAds', { ad_format: 'reward' }).then(function (res) {
        return res && res.result === true;
      }),
      timeoutP,
    ])
      .catch(function () { return false; })
      .then(function (rewardedOk) {
        rewardedAvailable = rewardedOk;
        var btn = document.getElementById('btn-hint');
        if (btn) btn.textContent = rewardedOk ? HINT_LABEL_AD : HINT_LABEL_FREE;
        console.log('[Platform] Rewarded ' + (rewardedOk ? 'доступен' : 'недоступен (adblock?) — подсказка бесплатная'));
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

  function load() {
    if (!available) {
      try {
        var raw = localStorage.getItem(DEV_SAVE_KEY);
        return Promise.resolve(raw ? JSON.parse(raw) : null);
      } catch (e) { return Promise.resolve(null); }
    }
    return vkBridge.send('VKWebAppStorageGet', { keys: [STORAGE_KEY] })
      .then(function (res) {
        var raw = res.keys && res.keys[0] && res.keys[0].value;
        return raw ? JSON.parse(raw) : null;
      })
      .catch(function (e) {
        console.error('[Platform] StorageGet ошибка:', e);
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
  function showRewarded(onReward, onClose) {
    if (!available) { if (onClose) onClose(false); return; }
    if (!rewardedAvailable) {
      if (onReward) onReward();
      if (onClose) onClose(true);
      return;
    }
    vkFlushNow(); // событие «перед рекламой» — не ждём дебаунса
    vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'reward' })
      .then(function (res) {
        var rewarded = res.result === true;
        if (rewarded && onReward) onReward();
        if (onClose) onClose(rewarded);
      })
      .catch(function (e) {
        console.warn('[Platform] rewarded недоступен:', e);
        if (onClose) onClose(false);
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
  function getCatalog()                { return Promise.resolve([]); }
  function getPurchases()               { return Promise.resolve([]); }
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
