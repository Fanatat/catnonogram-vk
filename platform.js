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
   ============================================================ */
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
        return true;
      })
      .catch(function (err) {
        console.error('[Platform] VKWebAppInit ошибка:', err);
        return false;
      });
  }

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

  function save(fullState) {
    if (!available) {
      try { localStorage.setItem(DEV_SAVE_KEY, JSON.stringify(fullState)); } catch (e) { /* dev-режим, падать нельзя */ }
      return Promise.resolve();
    }
    return vkBridge.send('VKWebAppStorageSet', {
      key:   STORAGE_KEY,
      value: JSON.stringify(fullState),
    }).catch(function (e) {
      console.error('[Platform] StorageSet ошибка:', e);
    });
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

  // Ежедневный режим не входит в VK-порт — часы устройства без подмены.
  function now() { return new Date(); }

  // Полноэкранная реклама. onDone() зовём в любом исходе.
  function showInterstitial(onDone) {
    var finished = false;
    function done() { if (!finished) { finished = true; if (onDone) onDone(); } }

    if (!available) { done(); return; }
    vkBridge.send('VKWebAppShowNativeAds', { ad_format: 'interstitial' })
      .then(done)
      .catch(function (e) { console.warn('[Platform] interstitial недоступен:', e); done(); });
  }

  // Реклама за награду. onReward() — выдать награду. onClose() — вернуть
  // звук/состояние (зовём всегда после закрытия).
  function showRewarded(onReward, onClose) {
    if (!available) { if (onClose) onClose(false); return; }
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
  };
})();
