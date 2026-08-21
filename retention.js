/* ============================================================
   retention.js — модуль удержания: замок кампании + раздатчик уровней +
   серия входов. ТЗ №01. Только ВК-сборка (build.py подключает файл и
   тег <script> исключительно в build_vk() — в яндекс-сборку не входит).

   Чистые функции без побочных эффектов (тот же принцип, что в save.js):
   не трогают DOM, не читают Platform, не лезут в LEVELS/main.js напрямую.
   Игра передаёт всё нужное через config.callbacks и получает текущее
   время (Platform.now()) снаружи — модуль сам часы не читает, поэтому
   тестируется в Node без браузера (см. tools/test_retention_*.js) и
   переносится в другие игры студии (Словоход, Color Sort) без правок:
   конфиг у каждой игры свой, retention.js — общий.

   ТРИ НЕЗАВИСИМЫХ МЕХАНИКИ:
   1. Замок (isLevelOpen) — какие уровни кампании доступны игроку.
   2. Раздатчик (drip*) — как замок отодвигается со временем.
   3. Серия (streak*) — вход-по-вход, отдельно от замка и раздатчика.

   ДИЗАЙН-РЕШЕНИЕ (модуль недоспецифицирован в ТЗ на этот счёт, записано
   явно, чтобы решение было видно, а не спрятано в коде):
   «Накопитель» — это НЕ отдельно хранимое число, а РАЗНИЦА между
   «сколько уровней раздатчик уже открыл» (dripOpened — то самое «граница
   открытого» из ТЗ, п.2.5) и «докуда игрок реально добрался»
   (maxReachedIndex, из callbacks). Если бы накопитель хранился отдельным
   полем, его пришлось бы держать в синхроне с границей открытого вручную
   при каждой мутации — лишний источник рассинхрона ради того же самого
   числа. «Копится» и «тратится» — синонимы «растёт»/«убывает» этой
   разницы, а не два разных действия игрока: единственное действие,
   которое «тратит» накопитель — сыграть дальше (сдвинуть maxReachedIndex).
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Retention = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {

  var DEFAULT_CONFIG = {
    tickMs:          6 * 60 * 60 * 1000, // такт раздатчика (п.2.1)
    accumulatorCap:  4,                  // потолок накопителя (п.2.1)
    starterCount:    11,                 // стартовый запас, всегда открыт (п.2.1)
    streakThreshold: 3,                  // длина серии для полной награды (п.2.3)
    streakDayReward: { 2: 'hints', 3: 'style' }, // день -> тип награды (п.2.3)
    contentUnitName: 'puzzle', // название единицы контента для UI игры (i18n-ключ, не литерал)
    domSlots: {
      dripLine:    'retention-drip-line',
      streakLine:  'retention-streak-line',
      rewardToast: 'retention-reward-toast',
    },
    // Задел на будущее (Словоход/Color Sort используют «звёзды/мастерство» —
    // в нонограммах этой механики нет). Колбэк только объявлен, модуль
    // никогда сам его не вызывает — реализация не входит в это ТЗ.
    onMasteryEvent: null,
    callbacks: {
      totalLevels:      function ()  { return 0; },
      isCompleted:      function ()  { return false; },
      maxReachedIndex:  function ()  { return -1; },
      grantHints:       function ()  {},
      grantStyle:       function ()  {},
    },
  };

  function mergeConfig(overrides) {
    var cfg = {};
    var key;
    for (key in DEFAULT_CONFIG) if (DEFAULT_CONFIG.hasOwnProperty(key)) cfg[key] = DEFAULT_CONFIG[key];
    if (overrides) {
      for (key in overrides) {
        if (!overrides.hasOwnProperty(key)) continue;
        if (key === 'callbacks') {
          cfg.callbacks = {};
          var ck;
          for (ck in DEFAULT_CONFIG.callbacks) if (DEFAULT_CONFIG.callbacks.hasOwnProperty(ck)) cfg.callbacks[ck] = DEFAULT_CONFIG.callbacks[ck];
          for (ck in overrides.callbacks) if (overrides.callbacks.hasOwnProperty(ck)) cfg.callbacks[ck] = overrides.callbacks[ck];
        } else if (key === 'domSlots') {
          cfg.domSlots = {};
          var dk;
          for (dk in DEFAULT_CONFIG.domSlots) if (DEFAULT_CONFIG.domSlots.hasOwnProperty(dk)) cfg.domSlots[dk] = DEFAULT_CONFIG.domSlots[dk];
          for (dk in overrides.domSlots) if (overrides.domSlots.hasOwnProperty(dk)) cfg.domSlots[dk] = overrides.domSlots[dk];
        } else if (key === 'streakDayReward') {
          cfg.streakDayReward = {};
          var sk;
          for (sk in DEFAULT_CONFIG.streakDayReward) if (DEFAULT_CONFIG.streakDayReward.hasOwnProperty(sk)) cfg.streakDayReward[sk] = DEFAULT_CONFIG.streakDayReward[sk];
          for (sk in overrides.streakDayReward) if (overrides.streakDayReward.hasOwnProperty(sk)) cfg.streakDayReward[sk] = overrides.streakDayReward[sk];
        } else {
          cfg[key] = overrides[key];
        }
      }
    }
    return cfg;
  }

  /* ---------------------------------------------------------------
     ЗАМОК — приоритет правил строго по ТЗ п.2.1 (1..4, первое
     сработавшее правило решает).
     --------------------------------------------------------------- */
  function isLevelOpen(levelIndex, moduleState, config) {
    if (config.callbacks.isCompleted(levelIndex)) return true;              // 1. пройден
    if (levelIndex <= config.callbacks.maxReachedIndex()) return true;      // 2. уже достигнут
    if (levelIndex < config.starterCount) return true;                     // 3. стартовый запас
    var dripBoundary = config.starterCount + moduleState.dripOpened;       // 4. раздатчик, по порядку
    return levelIndex < dripBoundary;
  }

  /* ---------------------------------------------------------------
     РАЗДАТЧИК.
     --------------------------------------------------------------- */

  // Сколько сейчас «в накопителе» — открыто раздатчиком, но игрок ещё не
  // добрался (см. дизайн-решение в шапке файла).
  function dripBacklogCount(moduleState, config) {
    var reached  = config.callbacks.maxReachedIndex();
    var consumed = Math.max(0, Math.min(moduleState.dripOpened, (reached + 1) - config.starterCount));
    return moduleState.dripOpened - consumed;
  }

  // Продвигает раздатчик на nowMs тактов вперёд. Чистая функция — не
  // мутирует moduleState, возвращает НОВЫЙ объект (или тот же, если тактов
  // не набежало). Если накопитель полон — время «стоит»: lastTickAt не
  // продвигается вообще, поэтому простой не теряется — как только у
  // игрока появится место в накопителе (сыграет дальше), заслуженные
  // такты применятся сразу.
  function applyDripTick(moduleState, nowMs, config) {
    var backlog = dripBacklogCount(moduleState, config);
    var room = config.accumulatorCap - backlog;
    if (room <= 0) return moduleState;

    var elapsed = nowMs - moduleState.lastTickAt;
    if (elapsed < config.tickMs) return moduleState;

    var ticks = Math.floor(elapsed / config.tickMs);
    var grant = Math.min(ticks, room);
    if (grant <= 0) return moduleState;

    return {
      dripOpened: moduleState.dripOpened + grant,
      lastTickAt: moduleState.lastTickAt + grant * config.tickMs,
      lastEntryDay: moduleState.lastEntryDay,
      streakLen: moduleState.streakLen,
      streakRewards: moduleState.streakRewards,
    };
  }

  // Точное время следующего открытия (мс) либо null, если накопитель полон
  // (п.2.2 — тогда UI обязан показать фразу про максимум, а не время).
  function nextUnlockAtMs(moduleState, config) {
    if (dripBacklogCount(moduleState, config) >= config.accumulatorCap) return null;
    return moduleState.lastTickAt + config.tickMs;
  }

  // Сколько сейчас ОТКРЫТЫХ И НЕПРОЙДЕННЫХ уровней ждёт игрока — для
  // постоянной строки на экране (п.2.2). Считает по всей кампании
  // (стартовый запас + раздатчик), не только «бэклог» раздатчика — игроку
  // всё равно, откуда взялся открытый непройденный уровень.
  function openUnfinishedCount(moduleState, config) {
    var total = config.callbacks.totalLevels();
    var count = 0;
    for (var i = 0; i < total; i++) {
      if (isLevelOpen(i, moduleState, config) && !config.callbacks.isCompleted(i)) count++;
    }
    return count;
  }

  /* ---------------------------------------------------------------
     СЕРИЯ ВХОДОВ (п.2.3). todayKey — 'YYYY-M-D' по ЛОКАЛЬНОМУ времени
     игрока, строится вызывающим тем же приёмом, что _todayKey() в
     main.js (см. dayKeyFromDate ниже — идентичная формула).
     --------------------------------------------------------------- */

  function dayKeyFromDate(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // 'YYYY-M-D' → мс фиксированного (но произвольного) момента этой
  // календарной даты — только для разницы в днях между двумя ключами.
  // Идентична _dayAnchor() в main.js.
  function _dayAnchor(key) {
    var p = key.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  function dayDiff(fromKey, toKey) {
    return Math.round((_dayAnchor(toKey) - _dayAnchor(fromKey)) / 86400000);
  }

  // Событие «игрок вошёл в игру сегодня». Идемпотентно (повторный вызов в
  // тот же локальный день — no-op, «переход через полночь не даёт +2»).
  // Возвращает { state, reward }, reward — 'hints'|'style'|null.
  // Пропуск дня (diff > 1) сбрасывает серию буквально в 0 (ТЗ п.2.3,
  // «серия бинарная, пропуск = сброс в 0») — это НЕ «продолжает считать
  // сегодняшний день первым», сегодняшний вход лишь помечает точку отсчёта
  // (lastEntryDay), от которой следующий подряд идущий день снова
  // начнёт счёт 1→2→3. Уже выданное за прошлую серию (флаги streakRewards)
  // сбрасывается вместе с серией — новая серия может заслужить награды
  // заново; уже выданные предметы (косметика/подсказки) при этом НЕ
  // отбираются — их отбор не входит в зону ответственности модуля.
  function onEnter(moduleState, todayKey, config) {
    if (moduleState.lastEntryDay === todayKey) {
      return { state: moduleState, reward: null };
    }

    var diff = moduleState.lastEntryDay ? dayDiff(moduleState.lastEntryDay, todayKey) : null;
    var newLen;
    var freshSeries;
    if (diff === null) {
      newLen = 1; freshSeries = true;                 // самый первый вход в жизни
    } else if (diff === 1) {
      newLen = moduleState.streakLen + 1; freshSeries = false; // подряд
    } else {
      newLen = 0; freshSeries = true;                 // пропуск (diff>1) — сброс в 0
    }

    var rewards = freshSeries ? {} : shallowCopy(moduleState.streakRewards);
    var reward = null;
    var rewardKind = config.streakDayReward[String(newLen)];
    if (rewardKind && !rewards[newLen]) {
      rewards[newLen] = true;
      reward = rewardKind;
    }

    return {
      state: {
        dripOpened:    moduleState.dripOpened,
        lastTickAt:    moduleState.lastTickAt,
        lastEntryDay:  todayKey,
        streakLen:     newLen,
        streakRewards: rewards,
      },
      reward: reward,
    };
  }

  function shallowCopy(obj) {
    var out = {};
    for (var k in obj) if (obj.hasOwnProperty(k)) out[k] = obj[k];
    return out;
  }

  /* ---------------------------------------------------------------
     ИНИЦИАЛИЗАЦИЯ / МИГРАЦИЯ (п.2.5). Один и тот же путь для новичка и
     для старого сейва без полей модуля — различие только в исходном
     maxReachedIndex, которое передаёт вызывающий (main.js/save.js):
     у настоящего новичка это -1 (или что игра считает «ничего не
     достигнуто»), у мигрирующего старого сейва — реальный прогресс.
     --------------------------------------------------------------- */
  function initState(maxReachedIndex, nowMs, config) {
    var isBrandNew = maxReachedIndex < 0;
    var dripOpened = isBrandNew
      ? config.accumulatorCap
      : Math.max(0, (maxReachedIndex + 1) - config.starterCount);
    return {
      dripOpened:    dripOpened,
      lastTickAt:    nowMs,
      lastEntryDay:  '',
      streakLen:     0,
      streakRewards: {},
    };
  }

  // true, если moduleState структурно валиден (защита от битых/чужих
  // данных при загрузке сейва — тот же принцип, что в save.js migrate()).
  function isValidState(x) {
    return !!x && typeof x === 'object'
      && typeof x.dripOpened === 'number'
      && typeof x.lastTickAt === 'number'
      && typeof x.lastEntryDay === 'string'
      && typeof x.streakLen === 'number'
      && !!x.streakRewards && typeof x.streakRewards === 'object';
  }

  /* ---------------------------------------------------------------
     КОМПАКТНОЕ ПРЕДСТАВЛЕНИЕ ДЛЯ СЕЙВА (п.2.5: ≤120 байт, короткие
     ключи). streakRewards — битовая маска (день N -> бит N), не объект:
     единственные дни с наградами в конфиге — 2 и 3, влезают в 2 бита.
     --------------------------------------------------------------- */
  function encodeState(moduleState) {
    var r = 0;
    for (var day in moduleState.streakRewards) {
      if (moduleState.streakRewards.hasOwnProperty(day) && moduleState.streakRewards[day]) {
        r |= (1 << (+day));
      }
    }
    return {
      t: moduleState.lastTickAt,
      b: moduleState.dripOpened,
      d: moduleState.lastEntryDay,
      s: moduleState.streakLen,
      r: r,
    };
  }

  function decodeState(encoded) {
    var rewards = {};
    for (var day = 0; day <= 31; day++) {
      if (encoded.r & (1 << day)) rewards[day] = true;
    }
    return {
      dripOpened:    encoded.b,
      lastTickAt:    encoded.t,
      lastEntryDay:  encoded.d,
      streakLen:     encoded.s,
      streakRewards: rewards,
    };
  }

  function isValidEncoded(x) {
    return !!x && typeof x === 'object'
      && typeof x.t === 'number' && typeof x.b === 'number'
      && typeof x.d === 'string' && typeof x.s === 'number' && typeof x.r === 'number';
  }

  return {
    DEFAULT_CONFIG:      DEFAULT_CONFIG,
    mergeConfig:         mergeConfig,
    isLevelOpen:         isLevelOpen,
    dripBacklogCount:    dripBacklogCount,
    applyDripTick:       applyDripTick,
    nextUnlockAtMs:      nextUnlockAtMs,
    openUnfinishedCount: openUnfinishedCount,
    dayKeyFromDate:      dayKeyFromDate,
    dayDiff:             dayDiff,
    onEnter:             onEnter,
    initState:           initState,
    isValidState:        isValidState,
    encodeState:         encodeState,
    decodeState:         decodeState,
    isValidEncoded:      isValidEncoded,
  };
});
