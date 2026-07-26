/* ============================================================
   main.js — точка входа.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  // ПК-модерация (п.1.6.2.7): модератор кликал ПКМ по игровому полю —
  // каждый клик открывал системное контекстное меню браузера. Гасим
  // contextmenu и selectstart на всём приложении (все игровые экраны,
  // не только поле), плюс CSS user-select:none (style.css, #app).
  var appEl = document.getElementById('app');
  appEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  appEl.addEventListener('selectstart', function (e) { e.preventDefault(); });

  Sound.init();

  // Задача F: подпись версии/билда (build.js — единственный источник истины,
  // руками строку тут не набирать).
  var buildTagEl = document.getElementById('build-tag');
  if (buildTagEl && window.BUILD_VERSION) buildTagEl.textContent = window.BUILD_VERSION;

  /* ---- Категории сложности ---- */

  var CATEGORIES = [
    { key: 'catTutorial', indices: [0, 1, 2] },                              // 5×5
    { key: 'catEasy',     indices: [3, 4, 5, 6, 7, 8, 9, 10] },              // 5×5 + 6×6
    { key: 'catMedium',   indices: [11, 12, 13, 14, 17, 18, 19] },           // 7×7 + 10×10
    { key: 'catHard',     indices: [15, 16, 20, 21, 22, 23, 24, 25, 26,     // 8×8 + 12×12 + 15×15
                                     27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37] }, // долив п.2.9: 13×13 + 14×14 + 15×15
    // Задача K: перенесённые из daily-пула 92 уровня (10×10/12×12),
    // отдельной категорией — не смешиваем с catHard, чтобы не «занижать»
    // сложность после 15×15 в конце старой кампании. Индексы 38-129
    // (id 39-130 в levels.js), отсортированы по возрастанию площади/плотности.
    { key: 'catLibrary',  indices: _range(38, 129) },
  ];

  function _range(from, to) {
    var arr = [];
    for (var i = from; i <= to; i++) arr.push(i);
    return arr;
  }

  /* ---- Состояние ---- */

  var _completedLevels = {};  // { "0": true, "3": true, … }
  var _lastLevelIndex  = -1;  // последний открытый уровень (для «Продолжить»)
  var _onboardingSeen  = false;
  var _muted           = false;
  var _boardStates     = {};  // { levelIndex: board[][] }
  var _saveTimer       = null;
  var _currentLevel    = -1;
  var _dailyDone       = '';  // 'YYYY-M-D' локальная дата последнего зачёта daily
  var _streak          = 0;   // дней подряд
  var _dailyDays       = {};  // { 'YYYY-M-D': true } — пройденные дни текущего локального месяца
  var _dailyBoard      = null; // прогресс ТЕКУЩЕГО дня (доска), если не доигран
  var _dailyBoardDate  = '';   // 'YYYY-M-D', которой принадлежит _dailyBoard
  var _dailySaveTimer  = null;
  var _inDailyGame     = false; // сейчас открыт экран daily-пазла (для флаша при сворачивании)
  var _cosmeticsOwned  = {};  // { productId: true } — куплено навсегда (Задача E)
  var _activeCosmetic  = '';  // id включённой косметики либо '' (дефолтная тема)

  // Задача I: реестр гамм. themeClass='' — базовая бесплатная тема (текущая
  // тёплая бумага), её applyCosmetic просто снимает все остальные классы.
  // swatchBg/swatchInk — превью-цвета КАРТОЧКИ в магазине (не var(--…),
  // чтобы плитка была видна независимо от активной темы, как и раньше в E).
  var COSMETICS = [
    { id: '',                 themeClass: '',               nameKey: 'cosmeticDefaultName',
      free: true,  swatchBg: '#f3ead6', swatchInk: '#2b2723' },
    { id: 'cosmetic_ink_blue', themeClass: 'theme-ink-blue', nameKey: 'cosmeticInkBlueName',
      free: false, swatchBg: '#f3ead6', swatchInk: '#1f2d4a' },
    { id: 'cosmetic_sepia',    themeClass: 'theme-sepia',    nameKey: 'cosmeticSepiaName',
      free: false, swatchBg: '#ece0c8', swatchInk: '#4a3728' },
    { id: 'cosmetic_graphite', themeClass: 'theme-graphite', nameKey: 'cosmeticGraphiteName',
      free: false, swatchBg: '#e9e7e2', swatchInk: '#2e2e30' },
  ];
  var COSMETIC_UNLOCK_LEVELS  = 3; // разблокировка МАГАЗИНА после N пройденных уровней
  var SAVE_SIZE_GUARD_BYTES   = 150000; // 75% от лимита Яндекса 200КБ (сверено с доками)

  /* ---- Звук ---- */

  var _soundBtns = document.querySelectorAll('.sound-btn');

  function updateSoundBtns() {
    _soundBtns.forEach(function (btn) {
      btn.classList.toggle('is-muted', _muted);
    });
  }

  function toggleSound() {
    _muted = !_muted;
    Sound.setMuted(_muted);
    updateSoundBtns();
    saveProgress();
  }

  _soundBtns.forEach(function (btn) {
    btn.addEventListener('click', toggleSound);
  });

  // Тумблер режима — вешаем один раз
  var modeBtns = document.querySelectorAll('.mode-btn');
  modeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      modeBtns.forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      Nonogram.setMode(parseInt(btn.dataset.mode, 10));
    });
  });

  document.getElementById('btn-hint').addEventListener('click', onHintClick);

  // Очистка поля — свободный режим, ошибки не подсвечиваются, игрок может
  // запутаться. Бесплатно, без рекламы (это не бонус — п.4.5.2: rewarded
  // только на подсказке, реклама не должна блокировать прохождение).
  document.getElementById('btn-clear-board').addEventListener('click', function () {
    document.getElementById('clear-confirm-overlay').hidden = false;
  });
  document.getElementById('btn-clear-cancel').addEventListener('click', function () {
    document.getElementById('clear-confirm-overlay').hidden = true;
  });
  document.getElementById('btn-clear-yes').addEventListener('click', onClearBoardConfirmed);

  Platform.init().then(function () {
    var lang = Platform.getLang();
    I18N.pick(lang);
    I18N.apply();
    // aria-label не текстовый узел (data-i18n его не берёт) — те же кнопки-
    // иконки в шапке (‹, ♪) исторически не локализуются вовсе; здесь
    // локализуем явно, раз уж заводим новую подпись.
    document.getElementById('btn-clear-board').setAttribute('aria-label', I18N.t('clearBoard'));

    if (!Platform.isAvailable()) {
      document.getElementById('dev-badge').hidden = false;
    }

    Platform.load().then(function (data) {
      // Миграция/нормализация сейва живёт в save.js — main.js только раскладывает
      // результат по переменным состояния (см. migrate() для деталей формата v1).
      var migrated = Save.migrate(data, LEVELS.length);

      _completedLevels = migrated.completedLevels;
      _lastLevelIndex  = migrated.lastLevelIndex;
      _onboardingSeen  = migrated.onboardingSeen;
      _muted           = migrated.muted;
      _boardStates     = migrated.boardStates;
      _dailyDone       = migrated.dailyDone;
      _streak          = migrated.streak;
      _dailyBoard      = migrated.dailyBoard;
      _dailyBoardDate  = migrated.dailyBoardDate;
      _cosmeticsOwned  = migrated.cosmeticsOwned;
      _activeCosmetic  = migrated.activeCosmetic;
      applyCosmetic(_activeCosmetic);

      // Восстанавливаем только дни текущего локального месяца
      var _nowLoad = Platform.now();
      var _loadY   = _nowLoad.getFullYear();
      var _loadM   = _nowLoad.getMonth() + 1;
      _dailyDays = {};
      Object.keys(migrated.dailyDays).forEach(function (k) {
        var p = k.split('-');
        if (+p[0] === _loadY && +p[1] === _loadM) _dailyDays[k] = true;
      });

      // Прогресс daily принадлежит конкретному дню — если день сменился
      // между сеансами, старая недоигранная доска больше не актуальна.
      if (_dailyBoardDate && _dailyBoardDate !== _todayKey()) {
        _dailyBoard     = null;
        _dailyBoardDate = '';
      }

      Sound.setMuted(_muted);
      updateSoundBtns();
      showMenu();
      Platform.ready();
      restorePurchases();

      // Сейв пишется целиком со всеми полями (правило студии) — сразу фиксируем
      // результат migrate() (миграция v1 и/или тихая подчистка призрачных
      // пустых досок), чтобы он не остался только в памяти до следующего хода.
      saveProgress();

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'hidden') return;
        if (_currentLevel >= 0) flushBoardSave(_currentLevel);
        if (_inDailyGame)       flushDailySave();
      });
    });
  });

  /* ---- Сохранение (всегда все поля целиком) ---- */

  function saveProgress() {
    var payload = {
      completedLevels: _completedLevels,
      lastLevelIndex:  _lastLevelIndex,
      onboardingSeen:  _onboardingSeen,
      muted:           _muted,
      boardStates:     _boardStates,
      dailyDone:       _dailyDone,
      streak:          _streak,
      dailyDays:       _dailyDays,
      dailyBoard:      _dailyBoard,
      dailyBoardDate:  _dailyBoardDate,
      cosmeticsOwned:  _cosmeticsOwned,
      activeCosmetic:  _activeCosmetic,
    };
    // Сторож байтов (ЖЁСТКОЕ ОГРАНИЧЕНИЕ задания): при риске переполнения
    // лимита Яндекса (200КБ/игрока) вытесняет boardStates, никогда прогресс.
    Platform.save(Save.enforceSizeGuard(payload, SAVE_SIZE_GUARD_BYTES));
  }

  /* ---- Ежедневный режим: дата → индекс ---- */

  // Граница дня — ЛОКАЛЬНАЯ полночь игрока (не UTC). Так интуитивнее для
  // игрока: «сегодня» — это его сегодня, а не Гринвич.
  //
  // Осознанное упрощение: игрок может перевести системные часы/часовой
  // пояс вперёд-назад, чтобы продлить стрик или переиграть daily раньше
  // времени. Мы сознательно НЕ защищаемся от этого (потребовало бы
  // доверенного серверного времени) — при масштабе и жанре игры это не
  // считается бизнес-риском, а не недосмотром.
  function _todayKey() {
    var d = Platform.now();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // Задача K: пул daily сужен до первых DAILY_POOL_SIZE записей (30-92
  // перенесены в кампанию, см. LEVELS). DAILY_LEVELS остаётся 122 записи
  // как есть — физически ничего не удаляем (иначе схлопнется индексация
  // хвоста). DAILY_POOL_CUTOVER — дата этого изменения: ДЛЯ ДАТ ДО и
  // ВКЛЮЧАЯ неё формула БУКВАЛЬНО та же, что была (mod DAILY_LEVELS.length) —
  // иначе индекс «сегодня»/«вчера» у уже игравших сдвинется на другой пазл
  // задним числом (шрам стандарта студии про перетасовку daily-пула).
  // Только ПОСЛЕ cutover цикл идёт по укороченному пулу, начиная с 0.
  var DAILY_POOL_SIZE    = 30;
  var DAILY_POOL_CUTOVER = '2026-7-25';

  function _dailyIndex() {
    var days        = Math.round((_dayAnchor(_todayKey())        - _dayAnchor('2024-1-1')) / 86400000);
    var cutoverDays = Math.round((_dayAnchor(DAILY_POOL_CUTOVER) - _dayAnchor('2024-1-1')) / 86400000);

    if (days <= cutoverDays) {
      return ((days % DAILY_LEVELS.length) + DAILY_LEVELS.length) % DAILY_LEVELS.length;
    }
    var since = days - cutoverDays - 1;
    return ((since % DAILY_POOL_SIZE) + DAILY_POOL_SIZE) % DAILY_POOL_SIZE;
  }

  // 'YYYY-M-D' → мс некоторого фиксированного (но произвольного) момента,
  // однозначно соответствующего этой календарной дате. Используется ТОЛЬКО
  // для разницы в днях между двумя такими ключами — реальный часовой пояс
  // тут ни при чём, это просто приём точной целочисленной арифметики дат.
  function _dayAnchor(key) {
    var p = key.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  // Пересчёт стрика по КАЛЕНДАРНЫМ дням (локальным), не по прошедшим
  // миллисекундам. Вызывается ДО обновления _dailyDone, поэтому
  // lastDate = старый _dailyDone.
  function _calcStreak(todayKey, lastDate, currentStreak) {
    if (!lastDate) return 1;                           // первый зачёт в жизни
    var diff = Math.round(
      (_dayAnchor(todayKey) - _dayAnchor(lastDate)) / 86400000
    );
    if (diff === 0) return currentStreak;              // тот же локальный день — не трогаем
    if (diff === 1) return currentStreak + 1;          // вчера → серия продолжается
    return 1;                                          // пропуск → сброс, новая серия
  }

  // true, если доска не содержит ни одной значимой отметки (закраски или
  // крестика) — такую доску незачем писать в сейв (фикс призрачных записей).
  function boardHasMarks(board) {
    for (var r = 0; r < board.length; r++) {
      for (var c = 0; c < board[r].length; c++) {
        if (board[r][c]) return true;
      }
    }
    return false;
  }

  // Пишет доску уровня в сейв, только если на ней есть хоть одна отметка —
  // компактно (Save.encodeBoard: RLE вместо массива массивов), с отметкой
  // времени для вытеснения самых старых. Если доска опустела (игрок сам
  // всё стёр) и старая запись была — убираем её.
  function persistBoardState(levelIndex) {
    var board = Nonogram.getBoardState();
    if (boardHasMarks(board)) {
      _boardStates[levelIndex] = Save.encodeBoard(board, Date.now());
      saveProgress();
    } else if (_boardStates[levelIndex]) {
      delete _boardStates[levelIndex];
      saveProgress();
    }
  }

  // Дебаунс 5 с после хода (лимит SDK 100 req/5 min)
  function scheduleBoardSave(levelIndex) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      _saveTimer = null;
      persistBoardState(levelIndex);
    }, 5000);
  }

  // Немедленное сохранение (уход, реклама, сворачивание)
  function flushBoardSave(levelIndex) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    persistBoardState(levelIndex);
  }

  /* ---- Гарантированный interstitial (Задача D) ---- */
  // Не полагаемся на скрытый частотный лимит SDK — считаем сами: пробуем
  // показать каждый 2-й пройденный уровень (кампания и ежедневный вместе),
  // и не чаще, чем раз в 75 с реального времени (требование: кулдаун 60-90с,
  // 75с — середина диапазона). На время показа звук и игра на паузе.
  var INTERSTITIAL_LEVEL_INTERVAL = 2;
  var INTERSTITIAL_COOLDOWN_MS    = 75000;
  var _levelsSinceInterstitial    = 0;
  var _lastInterstitialAt         = 0;

  function maybeShowInterstitial(onDone) {
    _levelsSinceInterstitial++;
    var due = _levelsSinceInterstitial >= INTERSTITIAL_LEVEL_INTERVAL &&
      (Date.now() - _lastInterstitialAt) >= INTERSTITIAL_COOLDOWN_MS;

    if (!due) { onDone(); return; }

    _levelsSinceInterstitial = 0;
    _lastInterstitialAt      = Date.now();
    Sound.suspend();
    Nonogram.setPaused(true);
    Platform.showInterstitial(function () {
      Nonogram.setPaused(false);
      Sound.resume();
      onDone();
    });
  }

  /* ---- Хелперы категорий ---- */

  function getCategoryOf(levelIndex) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].indices.indexOf(levelIndex) >= 0) return CATEGORIES[i];
    }
    return null;
  }

  // Первый непройденный уровень категории; если все пройдены — первый в категории
  function firstUnfinishedIn(cat) {
    for (var i = 0; i < cat.indices.length; i++) {
      if (!_completedLevels[cat.indices[i]]) return cat.indices[i];
    }
    return cat.indices[0];
  }

  function countCompleted(cat) {
    var n = 0;
    for (var i = 0; i < cat.indices.length; i++) {
      if (_completedLevels[cat.indices[i]]) n++;
    }
    return n;
  }

  /* ---- Навигация ---- */

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.remove('is-active');
    });
    document.getElementById(id).classList.add('is-active');
  }

  /* ---- Меню ---- */

  function showMenu() {
    showScreen('menu');

    var btnContinue = document.getElementById('btn-continue');
    var hasContinue = (_lastLevelIndex >= 0);
    btnContinue.hidden = !hasContinue;

    // onclick заменяет предыдущий обработчик — не накапливается при повторных вызовах
    document.getElementById('btn-play').onclick = function () {
      Sound.resumeContext();
      showCategory();
    };

    btnContinue.onclick = hasContinue ? function () {
      Sound.resumeContext();
      showGame(_lastLevelIndex);
    } : null;

    var btnDaily  = document.getElementById('btn-daily');
    var doneToday = (_dailyDone === _todayKey());
    btnDaily.classList.toggle('is-done', doneToday);
    btnDaily.onclick = function () {
      Sound.resumeContext();
      showDailyGame();
    };

    var streakEl = document.getElementById('daily-streak');
    if (_streak > 0) {
      streakEl.textContent = I18N.t('streakLabel').replace('{n}', _streak);
      streakEl.hidden = false;
    } else {
      streakEl.hidden = true;
    }

    document.getElementById('btn-calendar').onclick = function () {
      showCalendar();
    };

    document.getElementById('btn-shop').onclick = function () {
      Sound.resumeContext();
      showShop();
    };
  }

  /* ---- Косметика (Задача E — каркас, Задача I — несколько гамм) ---- */

  // Снимает/ставит CSS-класс темы напрямую — общий низкоуровневый шаг и
  // для применения купленной гаммы, и для временного «примерить».
  function applyThemeClass(themeClass) {
    COSMETICS.forEach(function (cos) {
      if (cos.themeClass) document.documentElement.classList.toggle(cos.themeClass, cos.themeClass === themeClass);
    });
  }

  function applyCosmetic(id) {
    var cos = null;
    for (var i = 0; i < COSMETICS.length; i++) {
      if (COSMETICS[i].id === id) { cos = COSMETICS[i]; break; }
    }
    applyThemeClass(cos ? cos.themeClass : '');
  }

  // Восстановление покупок (переустановка/новое устройство): getPurchases()
  // отдаёт то, что уже оплачено, но могло не попасть в сейв (сбой сети между
  // purchase() и consumePurchase()). Поле с id товара — ИМЕННО productID,
  // не id (сверено с докой Yandex Games SDK, sdk-purchases, 25.07.2026;
  // getCatalog() использует id — это разные структуры, не перепутать).
  function restorePurchases() {
    Platform.getPurchases().then(function (purchases) {
      if (!purchases || !purchases.length) return;
      var changed = false;
      purchases.forEach(function (p) {
        var known = false;
        for (var i = 0; i < COSMETICS.length; i++) {
          if (COSMETICS[i].id === p.productID) { known = true; break; }
        }
        if (!known) return;
        if (!_cosmeticsOwned[p.productID]) { _cosmeticsOwned[p.productID] = true; changed = true; }
        if (p.purchaseToken) Platform.consumePurchase(p.purchaseToken);
      });
      if (changed) saveProgress();
    });
  }

  function buildShopItemRow(cos, catalogMap) {
    var owned   = cos.free || !!_cosmeticsOwned[cos.id];
    var applied = (_activeCosmetic === cos.id);

    var row = document.createElement('div');
    row.className = 'shop-item';

    var swatch = document.createElement('div');
    swatch.className = 'shop-swatch';
    swatch.style.background = cos.swatchBg;
    swatch.setAttribute('aria-hidden', 'true');
    var swatchInk = document.createElement('div');
    swatchInk.className = 'shop-swatch-ink';
    swatchInk.style.background = cos.swatchInk;
    swatch.appendChild(swatchInk);

    var body = document.createElement('div');
    body.className = 'shop-item-body';
    var nameEl = document.createElement('p');
    nameEl.className = 'shop-item-name';
    nameEl.textContent = I18N.t(cos.nameKey);
    var statusEl = document.createElement('p');
    statusEl.className = 'shop-item-status';
    body.appendChild(nameEl);
    body.appendChild(statusEl);

    var actions = document.createElement('div');
    actions.className = 'shop-item-actions';

    // «Примерить до покупки» — временная смена темы, не трогает _activeCosmetic
    // и не сохраняется; сбрасывается при выходе с экрана (см. btn-back-shop).
    var previewBtn = document.createElement('button');
    previewBtn.className = 'btn btn-secondary';
    previewBtn.textContent = I18N.t('shopPreview');
    previewBtn.onclick = function () { applyThemeClass(cos.themeClass); };
    actions.appendChild(previewBtn);

    var mainBtn = document.createElement('button');
    mainBtn.className = 'btn btn-primary';

    if (owned) {
      statusEl.textContent = cos.free ? I18N.t('shopDefault') : I18N.t('shopOwned');
      mainBtn.textContent  = I18N.t(applied ? 'shopRemove' : 'shopApply');
      mainBtn.disabled = false;
      mainBtn.onclick = function () {
        _activeCosmetic = applied ? '' : cos.id;
        applyCosmetic(_activeCosmetic);
        saveProgress();
        showShop(); // перерисовать метки кнопок под новое состояние
      };
    } else if (!catalogMap) {
      // Каталог ещё не пришёл — не крашим, просто ждём (см. showShop).
      statusEl.textContent = I18N.t('shopLoading');
      mainBtn.textContent  = I18N.t('shopBuy');
      mainBtn.disabled = true;
    } else {
      // Разблокировано, не куплено, каталог пришёл. Код читает каталог
      // рантайм: товара нет в кабинете (или каталог пуст/недоступен) —
      // «скоро», без краша (то же поведение, что было в E).
      var product = catalogMap[cos.id];
      if (!product) {
        statusEl.textContent = I18N.t('shopUnavailable');
        mainBtn.textContent  = I18N.t('shopBuy');
        mainBtn.disabled = true;
      } else {
        // Цена цифрами + портальная валюта (п.1.13.4) — product.price уже
        // приходит в таком виде из getCatalog() (сверено с докой).
        statusEl.textContent = '';
        mainBtn.textContent = I18N.t('shopBuy') + ' — ' + product.price;
        mainBtn.disabled = false;
        mainBtn.onclick = function () {
          mainBtn.disabled = true;
          Platform.purchase(cos.id).then(function (result) {
            if (!result) {
              mainBtn.disabled = false; // отмена/ошибка — даём попробовать ещё раз
              return;
            }
            _cosmeticsOwned[cos.id] = true;
            _activeCosmetic = cos.id;
            applyCosmetic(_activeCosmetic);
            saveProgress();
            if (result.purchaseToken) Platform.consumePurchase(result.purchaseToken);
            showShop();
          });
        };
      }
    }

    actions.appendChild(mainBtn);
    row.appendChild(swatch);
    row.appendChild(body);
    row.appendChild(actions);
    return row;
  }

  function showShop() {
    showScreen('shop');

    document.getElementById('btn-back-shop').onclick = function () {
      applyCosmetic(_activeCosmetic); // сброс временной примерки при выходе
      showMenu();
    };

    var doneCount = Object.keys(_completedLevels).length;
    var unlocked  = doneCount >= COSMETIC_UNLOCK_LEVELS;
    var lockedEl  = document.getElementById('shop-locked-status');
    var listEl    = document.getElementById('shop-list');

    if (!unlocked) {
      lockedEl.hidden = false;
      lockedEl.textContent = I18N.t('shopLocked')
        .replace('{done}', doneCount)
        .replace('{need}', COSMETIC_UNLOCK_LEVELS);
      listEl.innerHTML = '';
      return;
    }

    lockedEl.hidden = true;
    listEl.innerHTML = '';
    COSMETICS.forEach(function (cos) {
      listEl.appendChild(buildShopItemRow(cos, null)); // null = каталог ещё не пришёл
    });

    Platform.getCatalog().then(function (catalog) {
      if (!document.getElementById('shop').classList.contains('is-active')) return; // экран уже закрыт
      var catalogMap = {};
      catalog.forEach(function (p) { catalogMap[p.id] = p; });
      listEl.innerHTML = '';
      COSMETICS.forEach(function (cos) {
        listEl.appendChild(buildShopItemRow(cos, catalogMap));
      });
    });
  }

  /* ---- Экран выбора сложнос��и ---- */

  function showCategory() {
    showScreen('category');
    document.querySelector('#category [data-i18n="chooseLevel"]').textContent =
      I18N.t('chooseLevel');
    document.getElementById('category-total').textContent =
      I18N.t('levelsAvailable');

    var list = document.getElementById('category-list');
    list.innerHTML = '';

    CATEGORIES.forEach(function (cat, catIdx) {
      var done  = countCompleted(cat);
      var total = cat.indices.length;
      var allDone = (done === total);

      var card = document.createElement('button');
      card.className = 'cat-card';

      var nameEl = document.createElement('span');
      nameEl.className = 'cat-name';
      nameEl.textContent = I18N.t(cat.key);

      var progEl = document.createElement('span');
      progEl.className = 'cat-progress' + (allDone ? ' is-done' : '');
      progEl.textContent = allDone
        ? I18N.t('catProgressAllDone')
        : (done > 0 ? I18N.t('catProgressDone').replace('{n}', done) : I18N.t('catProgressNone'));

      card.appendChild(nameEl);
      card.appendChild(progEl);

      // В категории «Обучение» — дополнительная кнопка «Как играть»
      if (catIdx === 0) {
        var howtoBtn = document.createElement('button');
        howtoBtn.className = 'cat-howto-btn';
        howtoBtn.textContent = I18N.t('howTo');
        howtoBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          showOnboarding(null);
        });
        card.appendChild(howtoBtn);
      }

      card.addEventListener('click', function () {
        var startIdx = firstUnfinishedIn(cat);
        if (!_onboardingSeen && catIdx === 0) {
          showOnboarding(function () { showGame(startIdx); });
        } else {
          showGame(startIdx);
        }
      });

      list.appendChild(card);
    });

    document.getElementById('btn-back-cat').onclick = function () {
      showMenu();
    };
  }

  /* ---- Календарь месяца ---- */

  function showCalendar() {
    showScreen('calendar');

    var now  = Platform.now();
    var y    = now.getFullYear();
    var m    = now.getMonth() + 1;  // 1-12

    document.getElementById('cal-title').textContent =
      I18N.t('month' + m) + ' ' + y;

    // Заголовки дней недели (Пн–Вс)
    var wdEl   = document.getElementById('cal-weekdays');
    var wdKeys = ['wdMon', 'wdTue', 'wdWed', 'wdThu', 'wdFri', 'wdSat', 'wdSun'];
    wdEl.innerHTML = '';
    wdKeys.forEach(function (k) {
      var el = document.createElement('div');
      el.className = 'cal-weekday';
      el.textContent = I18N.t(k);
      wdEl.appendChild(el);
    });

    // Сетка дней
    var grid      = document.getElementById('cal-grid');
    grid.innerHTML = '';

    var daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // getUTCDay(): 0=Вс…6=Сб → Mon-first: (dow+6)%7 → Пн=0…Вс=6
    var firstDow  = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    var offset    = (firstDow + 6) % 7;
    var todayKey  = _todayKey();

    for (var i = 0; i < offset; i++) {
      var empty = document.createElement('div');
      empty.className = 'cal-day empty';
      grid.appendChild(empty);
    }

    for (var d = 1; d <= daysInMonth; d++) {
      var dayKey = y + '-' + m + '-' + d;
      var cls    = 'cal-day';
      if (_dailyDays[dayKey]) cls += ' done';
      if (dayKey === todayKey) cls += ' today';
      var cell = document.createElement('div');
      cell.className = cls;
      cell.textContent = d;
      grid.appendChild(cell);
    }

    document.getElementById('btn-back-cal').onclick = function () {
      showMenu();
    };
  }

  /* ---- Онбординг ---- */

  function showOnboarding(onDone) {
    var overlay = document.getElementById('onboarding-overlay');
    overlay.hidden = false;

    document.getElementById('btn-onboarding-ok').onclick = function () {
      overlay.hidden = true;
      if (!_onboardingSeen) {
        _onboardingSeen = true;
        saveProgress();
      }
      if (onDone) onDone();
    };
  }

  /* ---- Ежедневный пазл ---- */

  // Дебаунс прогресса доски daily-пазла — тот же приём, что для обычных
  // уровней (scheduleBoardSave), но ключ не levelIndex, а сегодняшняя дата,
  // чтобы при смене дня старый прогресс не подхватился по ошибке.
  // Пишет доску daily в сейв, только если на ней есть хоть одна отметка —
  // тот же приём, что и persistBoardState (фикс призрачных записей).
  function persistDailyBoard() {
    var board = Nonogram.getBoardState();
    if (boardHasMarks(board)) {
      _dailyBoard     = Save.encodeBoard(board); // единственная daily-доска — без seq, вытеснение тут не нужно
      _dailyBoardDate = _todayKey();
      saveProgress();
    } else if (_dailyBoard) {
      _dailyBoard     = null;
      _dailyBoardDate = '';
      saveProgress();
    }
  }

  function scheduleDailySave() {
    if (_dailySaveTimer) clearTimeout(_dailySaveTimer);
    _dailySaveTimer = setTimeout(function () {
      _dailySaveTimer = null;
      persistDailyBoard();
    }, 5000);
  }

  function flushDailySave() {
    if (_dailySaveTimer) { clearTimeout(_dailySaveTimer); _dailySaveTimer = null; }
    persistDailyBoard();
  }

  // Подтверждена очистка поля (кнопка «Да» в оверлее). Работает и для
  // кампании, и для daily — определяем контекст по _inDailyGame, как и
  // остальной код (см. flushBoardSave/flushDailySave). Очищенная доска —
  // это и есть «нет черновика», поэтому пишем в сейв ровно то же, что уже
  // пишется при завершении уровня (delete из boardStates / null+'' для
  // daily), а не отдельную матрицу нулей — сейв остаётся целиком.
  function onClearBoardConfirmed() {
    document.getElementById('clear-confirm-overlay').hidden = true;
    Nonogram.clearBoard();

    if (_inDailyGame) {
      if (_dailySaveTimer) { clearTimeout(_dailySaveTimer); _dailySaveTimer = null; }
      _dailyBoard     = null;
      _dailyBoardDate = '';
      saveProgress();
    } else if (_currentLevel >= 0) {
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
      delete _boardStates[_currentLevel];
      saveProgress();
    }
  }

  function showDailyGame() {
    var idx   = _dailyIndex();
    var level = DAILY_LEVELS[idx];
    if (!level) { showMenu(); return; }

    _currentLevel = -1;   // обычное сохранение доски (по levelIndex) сюда не относится
    _inDailyGame  = true;
    document.getElementById('win-overlay').hidden = true;
    document.getElementById('confetti-container').innerHTML = '';
    var dlabel = I18N.t('dailyLabel');
    if (_streak > 0) dlabel += '  •  ' + I18N.t('streakLabel').replace('{n}', _streak);
    document.getElementById('game-level-label').textContent = dlabel;
    document.getElementById('btn-hint').disabled = false;
    document.getElementById('level-hint').hidden = true;

    modeBtns.forEach(function (b) {
      b.classList.toggle('is-active', parseInt(b.dataset.mode, 10) === 1);
    });

    showScreen('game');
    Nonogram.render(
      level,
      document.getElementById('puzzle-container'),
      function () { onDailyWin(level); },
      function ()  { Sound.tick(); scheduleDailySave(); },
      function ()  { Sound.lineClosed(); }
    );

    // Прогресс восстанавливаем, только если он от СЕГОДНЯШНЕГО дня
    // (устаревший при смене дня уже сброшен при загрузке сейва).
    if (_dailyBoard && _dailyBoardDate === _todayKey()) {
      Nonogram.restoreBoard(Save.decodeBoardAny(_dailyBoard));
    }

    document.getElementById('btn-back').onclick = function () {
      flushDailySave();
      _currentLevel = -1;
      _inDailyGame  = false;
      Nonogram.setPaused(false);
      Nonogram.resetZoom();
      showMenu();
    };
  }

  function onDailyWin(level) {
    Sound.win();
    document.getElementById('btn-hint').disabled = true;
    if (_dailySaveTimer) { clearTimeout(_dailySaveTimer); _dailySaveTimer = null; }
    var today  = _todayKey();
    _streak    = _calcStreak(today, _dailyDone, _streak);  // ДО обновления _dailyDone
    _dailyDone = today;
    _dailyDays[today] = true;
    _dailyBoard     = null;   // пазл дня пройден — прогресс-черновик больше не нужен
    _dailyBoardDate = '';
    saveProgress();

    buildSilhouette(level);
    document.getElementById('win-theme-label').textContent = I18N.t(level.theme);
    document.getElementById('win-overlay').hidden = false;
    launchConfetti();

    document.getElementById('btn-next-level').textContent = I18N.t('backToMenu');
    document.getElementById('btn-next-level').onclick = function () {
      _currentLevel = -1;
      _inDailyGame  = false;
      maybeShowInterstitial(showMenu);
    };
  }

  /* ---- Экран игры ---- */

  function showGame(levelIndex) {
    var level = LEVELS[levelIndex];
    if (!level) { showCategory(); return; }

    _currentLevel   = levelIndex;
    _lastLevelIndex = levelIndex;  // всегда обновляем для «Продолжить»
    _inDailyGame    = false;

    document.getElementById('win-overlay').hidden = true;
    document.getElementById('confetti-container').innerHTML = '';
    // #game-level-label используется и здесь, и в showDailyGame() — для
    // кампании он пуст (номер/общее число уровня на экране решения не
    // показываются, см. showCategory для сводки доступных уровней).
    document.getElementById('game-level-label').textContent = '';
    document.getElementById('btn-hint').disabled = false;

    // Направляющая подсказка — только на первом уровне (index 0)
    var hintEl = document.getElementById('level-hint');
    if (levelIndex === 0) {
      hintEl.hidden = false;
      var hintTimer = setTimeout(function () { hintEl.hidden = true; }, 4000);
      document.getElementById('puzzle-container').addEventListener('pointerdown', function () {
        clearTimeout(hintTimer);
        hintEl.hidden = true;
      }, { once: true });
    } else {
      hintEl.hidden = true;
    }

    modeBtns.forEach(function (b) {
      b.classList.toggle('is-active', parseInt(b.dataset.mode, 10) === 1);
    });

    showScreen('game');
    Nonogram.render(
      level,
      document.getElementById('puzzle-container'),
      function () { onWin(level, levelIndex); },
      function ()  { Sound.tick(); scheduleBoardSave(levelIndex); },
      function ()  { Sound.lineClosed(); }
    );

    if (_boardStates[levelIndex]) {
      Nonogram.restoreBoard(Save.decodeBoardAny(_boardStates[levelIndex]));
    }

    document.getElementById('btn-back').onclick = function () {
      flushBoardSave(levelIndex);
      _currentLevel = -1;
      Nonogram.setPaused(false);
      Nonogram.resetZoom();
      showCategory();
    };
  }

  /* ---- Победа ---- */

  function onWin(level, levelIndex) {
    Sound.win();
    document.getElementById('btn-hint').disabled = true;

    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    delete _boardStates[levelIndex];
    _completedLevels[levelIndex] = true;

    // Следующий уровень в той же категории
    var cat = getCategoryOf(levelIndex);
    var nextIndex = -1;
    if (cat) {
      var pos = cat.indices.indexOf(levelIndex);
      if (pos + 1 < cat.indices.length) nextIndex = cat.indices[pos + 1];
    }

    // lastLevelIndex: на следующий если есть, иначе остаёмся на текущем
    _lastLevelIndex = (nextIndex >= 0) ? nextIndex : levelIndex;
    saveProgress();

    buildSilhouette(level);
    document.getElementById('win-theme-label').textContent = I18N.t(level.theme);
    document.getElementById('win-overlay').hidden = false;
    launchConfetti();

    document.getElementById('btn-next-level').textContent = I18N.t('next');
    document.getElementById('btn-next-level').onclick = function () {
      _currentLevel = -1;
      maybeShowInterstitial(function () {
        if (nextIndex >= 0) {
          showGame(nextIndex);
        } else {
          showCategory();
        }
      });
    };
  }

  /* ---- Подсказка за рекламу ---- */

  function onHintClick() {
    var hint = Nonogram.findHint();
    if (!hint) {
      document.getElementById('btn-hint').disabled = true;
      return;
    }
    var pendingHint = null;
    if (_currentLevel >= 0) flushBoardSave(_currentLevel);
    Sound.suspend();
    Nonogram.setPaused(true);
    Platform.showRewarded(
      function () { pendingHint = hint; },
      function () {
        Nonogram.setPaused(false);
        Sound.resume();
        if (pendingHint) {
          Nonogram.applyHint(pendingHint);
          pendingHint = null;
          if (!Nonogram.findHint()) {
            document.getElementById('btn-hint').disabled = true;
          }
        }
      }
    );
  }

  /* ---- Силуэт ---- */

  // Задача G: картинка «проявляется» из клеток — juice-момент экрана
  // победы ТЕКУЩЕГО уровня, не путать с финалом кампании (не трогаем).
  var _silhouetteRAF = null;

  function buildSilhouette(level) {
    if (_silhouetteRAF) { cancelAnimationFrame(_silhouetteRAF); _silhouetteRAF = null; }

    var W = level.width, H = level.height;
    var CELL = Math.min(48, Math.floor(260 / Math.max(W, H)));
    var canvas = document.getElementById('win-canvas');
    canvas.width  = W * CELL;
    canvas.height = H * CELL;
    var ctx = canvas.getContext('2d');
    var style = getComputedStyle(document.documentElement);
    var bg  = style.getPropertyValue('--bg').trim()  || '#f3ead6';
    var ink = style.getPropertyValue('--ink').trim() || '#2b2723';

    var cells = [];
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (level.solution[r][c]) cells.push({ r: r, c: c });
      }
    }

    function paint(count) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = ink;
      for (var i = 0; i < count; i++) {
        ctx.fillRect(cells[i].c * CELL + 1, cells[i].r * CELL + 1, CELL - 2, CELL - 2);
      }
    }

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || cells.length === 0) { paint(cells.length); return; }

    // Случайный порядок — читается как "проявление", а не построчная отрисовка.
    for (var i = cells.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp;
    }

    var DURATION = 500;
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var progress = Math.min(1, (ts - start) / DURATION);
      paint(Math.ceil(progress * cells.length));
      if (progress < 1) {
        _silhouetteRAF = requestAnimationFrame(step);
      } else {
        _silhouetteRAF = null;
      }
    }
    _silhouetteRAF = requestAnimationFrame(step);
  }

  /* ---- Конфетти ---- */

  function launchConfetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var container = document.getElementById('confetti-container');
    var colors = ['#c9a84c', '#4a7c59', '#8b6f47', '#d4956a', '#2b2723'];
    for (var i = 0; i < 52; i++) {
      var el = document.createElement('div');
      var size = 5 + Math.random() * 8;
      el.className = 'confetti-piece';
      el.style.cssText =
        'left:'               + (Math.random() * 100)  + '%;' +
        'background:'         + colors[Math.floor(Math.random() * colors.length)] + ';' +
        'width:'              + size + 'px;' +
        'height:'             + size + 'px;' +
        'animation-delay:'    + (Math.random() * 0.5)  + 's;' +
        'animation-duration:' + (0.9 + Math.random() * 0.8) + 's;';
      container.appendChild(el);
    }
    setTimeout(function () { container.innerHTML = ''; }, 2500);
  }

});
