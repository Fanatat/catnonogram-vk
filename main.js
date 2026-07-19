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

  /* ---- Категории сложности ---- */

  var CATEGORIES = [
    { key: 'catTutorial', indices: [0, 1, 2] },                              // 5×5
    { key: 'catEasy',     indices: [3, 4, 5, 6, 7, 8, 9, 10] },              // 5×5 + 6×6
    { key: 'catMedium',   indices: [11, 12, 13, 14, 17, 18, 19] },           // 7×7 + 10×10
    { key: 'catHard',     indices: [15, 16, 20, 21, 22, 23, 24, 25, 26,     // 8×8 + 12×12 + 15×15
                                     27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37] }, // долив п.2.9: 13×13 + 14×14 + 15×15
  ];

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
    };
    // Сторож размера — перед КАЖДОЙ записью: если сериализованный сейв
    // больше лимита, выбрасывает самые старые недорешённые доски кампании,
    // пока не влезет (или пока не кончатся).
    Save.enforceSizeGuard(payload, Save.SAVE_SIZE_GUARD_BYTES);
    Platform.save(payload);
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

  function _dailyIndex() {
    // Номер календарного дня от фиксированной эпохи — чистая функция
    // ДАТЫ (не «прошедших миллисекунд»), поэтому не плывёт на переходах
    // летнего времени и одинакова у всех игроков в один и тот же
    // локальный календарный день. Пул зациклен: как только пройдены все
    // DAILY_LEVELS.length дней, номер дня начинает повторяться с начала.
    var days = Math.round((_dayAnchor(_todayKey()) - _dayAnchor('2024-1-1')) / 86400000);
    return ((days % DAILY_LEVELS.length) + DAILY_LEVELS.length) % DAILY_LEVELS.length;
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
  }

  /* ---- Экран выбора сложнос��и ---- */

  function showCategory() {
    showScreen('category');
    document.querySelector('#category [data-i18n="chooseLevel"]').textContent =
      I18N.t('chooseLevel');

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
      progEl.textContent = I18N.t('catDone').replace('{n}', done);

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
      function ()  { scheduleDailySave(); }
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
      Sound.suspend();
      Platform.showInterstitial(function () {
        Sound.resume();
        showMenu();
      });
    };
  }

  /* ---- Экран игры ---- */

  function showGame(levelIndex) {
    var level = LEVELS[levelIndex];
    if (!level) { showCategory(); return; }

    _currentLevel   = levelIndex;
    _lastLevelIndex = levelIndex;  // всегда обновляем для «Продолжить»
    _inDailyGame    = false;

    var cat      = getCategoryOf(levelIndex);
    var posInCat = cat ? (cat.indices.indexOf(levelIndex) + 1) : (levelIndex + 1);

    document.getElementById('win-overlay').hidden = true;
    document.getElementById('confetti-container').innerHTML = '';
    document.getElementById('game-level-label').textContent =
      I18N.t('levelLabel').replace('{n}', posInCat);
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
      function ()  { scheduleBoardSave(levelIndex); }
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
      Sound.suspend();
      Platform.showInterstitial(function () {
        Sound.resume();
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

  function buildSilhouette(level) {
    var W = level.width, H = level.height;
    var CELL = Math.min(48, Math.floor(260 / Math.max(W, H)));
    var canvas = document.getElementById('win-canvas');
    canvas.width  = W * CELL;
    canvas.height = H * CELL;
    var ctx = canvas.getContext('2d');
    var style = getComputedStyle(document.documentElement);
    ctx.fillStyle = style.getPropertyValue('--bg').trim()  || '#f3ead6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = style.getPropertyValue('--ink').trim() || '#2b2723';
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (level.solution[r][c]) {
          ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }
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
