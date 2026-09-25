/* ============================================================
   main.js — точка входа.
   ============================================================ */

// Debug-оверлей (2026-09-06, живой Android-баг с rewarded-рекламой):
// у основателя нет под рукой ПК+кабеля для chrome://inspect (remote
// debugging Android WebView) — печатаем те же строки, что шли бы в
// консоль, прямо на экране, чтобы можно было сфотографировать телефон.
// Активируется ?debug=1 — invisible по умолчанию, нулевой риск для
// обычных игроков. ГЛОБАЛЬНАЯ функция (не заперта в замыкании ниже) —
// adapters/vk_bridge.js и platform.js грузятся РАНЬШЕ этого файла, но
// зовут window.debugLog только по клику, т.е. уже после того, как этот
// скрипт целиком выполнился и window.debugLog определён; определяем ВНЕ
// DOMContentLoaded — элементы #debug-overlay/#debug-log физически уже в
// DOM к моменту выполнения этого файла (script лежит в конце body).
var DEBUG_MODE = /(^|[?&])debug=1(&|$)/.test(location.search);
// opts.big (2026-09-07, скриншот основателя: закрыл игру на 10-15с, не
// дождавшись итога) — крупная выделенная строка для финального исхода
// showRewarded, чтобы её нельзя было принять за очередную строку среди
// одинаковых и закрыть игру раньше времени.
window.debugLog = function (line, opts) {
  if (!DEBUG_MODE) return;
  var overlay = document.getElementById('debug-overlay');
  var log = document.getElementById('debug-log');
  if (!overlay || !log) return;
  overlay.hidden = false;
  var now = new Date();
  var ts = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + ':' +
    ('0' + now.getSeconds()).slice(-2) + '.' + ('00' + now.getMilliseconds()).slice(-3);
  var row = document.createElement('div');
  if (opts && opts.big) row.className = 'debug-log-final';
  row.textContent = '[' + ts + '] ' + line;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  // Дублируем в консоль — на десктопе/эмуляторе удобнее читать оттуда,
  // дублирование ничему не мешает.
  console.log('[debug] ' + line);
};
// ТЗ №53, п.3.3: строка нужна для диагностики «карточка не влезает»/
// «баннер не появился» на живом заходе основателя — viewport/dpr/
// vk_platform одной строкой сразу при включении debug-режима.
function debugLogViewport() {
  var p = '-';
  try { p = (new URLSearchParams(location.search)).get('vk_platform') || '-'; } catch (e) { /* падать нельзя */ }
  window.debugLog('viewport ' + window.innerWidth + 'x' + window.innerHeight +
    ', dpr=' + (window.devicePixelRatio || 1) + ', vk_platform=' + p);
}
if (DEBUG_MODE) {
  window.debugLog('env: AndroidBridge=' + !!window.AndroidBridge + ' UA=' + navigator.userAgent.slice(0, 70));
  debugLogViewport();
}

document.addEventListener('DOMContentLoaded', function () {

  var debugClearBtn = document.getElementById('debug-clear');
  if (debugClearBtn) {
    debugClearBtn.addEventListener('click', function () {
      var log = document.getElementById('debug-log');
      if (log) log.innerHTML = '';
    });
  }

  // Скрытая активация debug-оверлея тапами (2026-09-07, задача #47):
  // в мобильном приложении ВК адресной строки нет, ?debug=1 дописать
  // некуда — ровно там и живёт баг с rewarded-рекламой. 5 тапов подряд
  // (в течение 2с) включают тот же оверлей, что и ?debug=1. Обычный игрок
  // так не жмёт — риск случайной активации фактически нулевой.
  //
  // ДВЕ точки, ОДИН общий счётчик (находка сессии-напарника, game3/
  // color_sort, та же ночь): изначально висело только на заголовке меню
  // (.game-title) — бесполезно ровно в сценарии, где нужнее всего: игра
  // зависла на экране ЗАГРУЗКИ, меню не показано, .game-title скрыт
  // (display:none внутри неактивного .screen) и физически не может
  // получить клик. #loading — единственный экран без единой боевой
  // кнопки, тапать по нему нечего портить.
  (function () {
    var TAP_COUNT = 5;
    var TAP_WINDOW_MS = 2000;
    var taps = [];
    function onTap() {
      var now = Date.now();
      taps.push(now);
      taps = taps.filter(function (t) { return now - t <= TAP_WINDOW_MS; });
      if (taps.length < TAP_COUNT) return;
      taps = [];
      if (DEBUG_MODE) return;
      DEBUG_MODE = true;
      window.debugLog('env: AndroidBridge=' + !!window.AndroidBridge + ' UA=' + navigator.userAgent.slice(0, 70));
      debugLogViewport();
      window.debugLog('debug-режим включён 5 тапами');
    }
    var loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.addEventListener('click', onTap);
    var titleEl = document.querySelector('.game-title');
    if (titleEl) titleEl.addEventListener('click', onTap);
  })();

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

  // ТЗ №01: модуль удержания. maxReachedIndex/bonusHints/retention — см.
  // save.js emptySave() (там же смысл каждого поля). retentionState —
  // распакованный (decodeState) вид retention для рантайма; сериализуется
  // обратно в payload только в saveProgress(). ТЗ №50: замок теперь по
  // ПОЗИЦИЯМ (chapters_map.js) — _maxReachedPos — самая дальняя ПОЗИЦИЯ
  // (не индекс LEVELS), сериализуется в то же поле сейва maxReachedIndex
  // (имя не менялось, см. save.js).
  var _maxReachedPos = -1;
  var _bonusHints      = 0;
  var _retentionState  = null;
  // ТЗ №50: главы, за которые уже выдана награда (открытка + подсказки) —
  // { ch01: true, … }, см. save.js emptySave()/migrate().
  var _postcards       = {};
  // 2026-09-25: главы, открытые досрочно за рекламу — { ch05: true, … }
  // (см. isChapterOpen, save.js emptySave()).
  var _chaptersUnlocked = {};

  // ТЗ №49: лестница 7 дней (ladder.js). _ladderState — поля как в сейве
  // (save.js emptySave: ladderDay/ladderLastDay/ladderSeries/
  // ladderClaimedDay), не сериализуется отдельно — плоские поля пишутся
  // прямо в payload (saveProgress). _ladderPending — НЕ персистится: флаг
  // «сегодняшний день лестницы открылся в ЭТОЙ сессии» на время до первого
  // showMenu(); сохранённого состояния (ladderLastDay) достаточно, чтобы
  // Ladder.isClaimed()/Ladder.advance() сами разобрались при следующей
  // загрузке, даже если игрок закрыл вкладку, не забрав награду.
  var _ladderState  = { day: 0, lastDay: '', series: 0, claimedDay: '' };
  var _ladderPending = false;
  // ТЗ №49, п.5: { fav, rec, shortcut, review } — какие крючки площадки
  // уже показаны этому игроку, каждый не больше одного раза.
  var _hooksShown = {};

  // ТЗ №49, п.5: тайминг текущего пазла для track('puzzle_done', {sec,hints}) —
  // сброс в showGame()/showDailyGame(), считывается в onWin()/onDailyWin().
  var _levelStartedAt     = 0;
  var _hintsUsedThisLevel = 0;

  // ТЗ №51: кнопка «Проверить» + мягкие тосты. Всё в памяти сессии,
  // НЕ в сейве — бесплатная проверка/тосты «сгорают» при перезагрузке
  // страницы, это осознанно (постановка: «в памяти сессии, не в сейве»).
  var _freeCheckUsed  = {}; // { key: true } — бесплатная проверка уже потрачена на эту картинку
  var _nudgeShownFor  = {}; // { key: true } — тост «лишняя клетка» уже показан на этой картинке
  var _nearWinShownFor = {}; // { key: true } — тост «почти собрал» уже показан на этой картинке
  var _errorSince = 0;    // мс (Date.now()) — с какого момента hasErrors() непрерывно true, 0 = сейчас нет ошибок
  var _lastMoveAt = 0;    // мс (Date.now()) — время последнего хода на текущей картинке
  var _nudgeTimer = null; // setInterval, живёт только пока открыт экран игры

  // Конфиг модуля (ТЗ №01, п.2.6) — колбэки замыкают состояние ИГРЫ,
  // сам retention.js про LEVELS/COSMETICS ничего не знает. typeof-проверка
  // (историческая, до ТЗ №26 отличала площадки — теперь Retention
  // подключён в обеих сборках, блок ниже выполняется на обеих) молча не
  // падает, если retention.js всё же не подключён (dev-запуск исходника
  // напрямую, без build.py).
  var RETENTION_TICK_MS = 6 * 60 * 60 * 1000; // такт раздатчика (боевой, 6ч)

  // ТЗ №51: пороги мягких тостов-подсказок (§3) — 60с непрерывной ошибки
  // и 10с простоя после последнего хода для «Кажется, где-то лишняя
  // клетка».
  var NUDGE_ERROR_MS = 60000;
  var NUDGE_IDLE_MS  = 10000;

  // ТЗ №49а: текст «+N подсказки» шёл фикс. словом мн.ч. — при n=1 читалось
  // «+1 подсказки». Общая функция для обоих мест (grantHints-тост и
  // тост/карточка лестницы), чтобы склонение не дублировалось.
  function retentionRewardHintsText(n) {
    var word = I18N.pluralRu(n, [I18N.t('rewardHintsOne'), I18N.t('rewardHintsFew'), I18N.t('rewardHintsMany')]);
    return I18N.t('retentionRewardHints').replace('{n}', n).replace('{word}', word);
  }

  var RETENTION_CONFIG = (typeof Retention !== 'undefined') ? Retention.mergeConfig({
    tickMs: RETENTION_TICK_MS,
    // ТЗ №08: «1 пазл в 6 часов» ощущался как дефицит, не пейсинг. Порция
    // 1->6, потолок 4->24 (= сутки полного простоя без потерь). Такт
    // (6 часов) не меняется. Числа утверждены основателем явно.
    dripPerTick: 6,
    accumulatorCap: 24,
    hintsRewardCount: 2, // п.2.3: «2-й день — подсказки (число задаётся конфигом)»
    // ТЗ №49, §2.3: лестница 7 дней (ladder.js) заменяет наградную часть
    // серии входов — retention.js по-прежнему СЧИТАЕТ streakLen/streakRewards
    // (Retention.onEnter вызывается как раньше, состояние сейва не ломаем),
    // но сам больше ничего не выдаёт: пустой streakDayReward — ни один
    // rewardKind не найдётся в onEnter(), reward всегда null.
    streakDayReward: {},
    callbacks: {
      totalLevels:     function ()  { return LEVELS.length; },
      // ТЗ №50: замок работает по ПОЗИЦИЯМ — весь модуль retention.js
      // (isLevelOpen/dripBoundary/…) получает и сравнивает позиции, не
      // индексы LEVELS; retention.js сам об этом не знает (числа для него
      // непрозрачны), поэтому здесь, на границе, позиция переводится в
      // индекс LEVELS, которым адресован _completedLevels.
      isCompleted:     function (pos) { return !!_completedLevels[ChaptersMap.posToIndex(pos)]; },
      maxReachedIndex: function ()  { return _maxReachedPos; },
      grantHints: function (n) {
        _bonusHints += n;
        updateHintBadge();
        updateCheckButton();
        showRetentionToast(retentionRewardHintsText(n));
      },
      grantStyle: function (id) {
        if (!_cosmeticsOwned[id]) _cosmeticsOwned[id] = true;
        showRetentionToast(I18N.t('retentionRewardStyle'));
      },
    },
  }) : null;

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
    // ТЗ №01, п.2.3: награда 3-го дня серии входов. НЕ продаётся (нет в
    // магазине как товар) — только выдаётся Retention (grantStyle),
    // отмечена streakReward:true, чтобы buildShopItemRow() не рисовал
    // кнопку «Купить» для того, что купить нельзя.
    { id: 'cosmetic_streak_rust', themeClass: 'theme-streak-rust', nameKey: 'cosmeticStreakRustName',
      free: false, streakReward: true, swatchBg: '#f3ead6', swatchInk: '#7a3b2e' },
    // ТЗ №49: награда за 7-й день лестницы — первая ТЁМНАЯ гамма студии.
    // streakReward:true — та же семантика, что и у cosmetic_streak_rust
    // (buildShopItemRow не рисует «Купить», выдаётся только Ladder-карточкой).
    { id: 'cosmetic_night', themeClass: 'theme-night', nameKey: 'cosmeticNightName',
      free: false, streakReward: true, swatchBg: '#1c1f26', swatchInk: '#e8e6df' },
  ];
  var COSMETIC_UNLOCK_LEVELS  = 3; // разблокировка МАГАЗИНА после N пройденных уровней
  // Байтовый лимит сейва — площадка-специфичный (Platform.SAVE_SIZE_GUARD_
  // BYTES, задан в platform.js/adapters/vk_bridge.js), общий код своего
  // значения не держит (ТЗ №01, п.1.1: два разных числа под одним именем —
  // сведены к одному источнику истины).

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
  document.getElementById('btn-check').addEventListener('click', onCheckClick);

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

    // ТЗ №09, фаза 1: сти́ки-баннер — сразу после init, живёт на всех
    // экранах (один показ на сессию, не по экрану). Только ВК —
    // Platform.showBannerAd не существует в яндекс-сборке (platform.js).
    if (Platform.showBannerAd) Platform.showBannerAd();

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

      _ladderState = {
        day:        migrated.ladderDay,
        lastDay:    migrated.ladderLastDay,
        series:     migrated.ladderSeries,
        claimedDay: migrated.ladderClaimedDay,
      };
      _hooksShown = migrated.hooksShown;

      _maxReachedPos = migrated.maxReachedIndex;
      _postcards       = migrated.postcards;
      _chaptersUnlocked = migrated.chaptersUnlocked;
      _bonusHints      = migrated.bonusHints;
      updateHintBadge(); // возвращающийся игрок мог накопить баланс ДО этой сессии
      updateCheckButton();
      if (typeof Retention !== 'undefined') {
        var _nowRet = Platform.now().getTime();
        _retentionState = Retention.isValidEncoded(migrated.retention)
          ? Retention.decodeState(migrated.retention)
          : Retention.initState(_maxReachedPos, _nowRet, RETENTION_CONFIG);
        // День засчитывается фактом входа (п.2.3), не прохождением уровня —
        // зовём один раз на старте сессии, до первого показа экранов.
        var _entryResult = Retention.onEnter(_retentionState, Retention.dayKeyFromDate(Platform.now()), RETENTION_CONFIG);
        _retentionState = _entryResult.state;
        if (_entryResult.reward === 'hints') RETENTION_CONFIG.callbacks.grantHints(RETENTION_CONFIG.hintsRewardCount);
        else if (_entryResult.reward === 'style') RETENTION_CONFIG.callbacks.grantStyle('cosmetic_streak_rust');
        // (streakDayReward:{} выше — _entryResult.reward всегда null сейчас;
        // ветки оставлены на случай будущего отката/A-B, поведение самого
        // retention.js не тронуто.)
      }

      if (typeof Ladder !== 'undefined') {
        // ТЗ №49, п.2.2: одноразовая миграция игрока старой серии входов
        // (retention.js) на лестницу — без неё вернувшийся живой игрок ВК
        // стартовал бы с ladderDay=0, теряя уже накопленную серию входов.
        // Retention.isValidEncoded(migrated.retention) — ключевой гейт:
        // отличает СУЩЕСТВУЮЩЕГО игрока (у него уже был сохранён блок
        // retention ДО этого ТЗ) от настоящего новичка. Без этого гейта
        // брать только «streakLen>=1 сегодня» было бы ловушкой: у
        // совершенно нового игрока onEnter() тоже сразу даёт streakLen=1 в
        // первый же день — migration-ветка сработала бы и для него,
        // выставив ladderLastDay=today ДО первого Ladder.advance(), и тот
        // увидел бы «уже открыто сегодня» на своём самом первом входе
        // (opened:false, карточка лестницы никогда бы не показалась).
        if (_ladderState.lastDay === '' && Retention.isValidEncoded(migrated.retention) &&
            _retentionState && _retentionState.lastEntryDay === _todayKey() && _retentionState.streakLen >= 1) {
          _ladderState.day    = Math.min(_retentionState.streakLen, 7);
          _ladderState.series = _retentionState.streakLen;
          _ladderState.lastDay = _todayKey();
          // Модуль уже выдал награду дня 2/3 СЕГОДНЯ (streakRewards[N] —
          // флаг конкретно текущего streakLen) — отмечаем день лестницы
          // забранным, чтобы не выдать ту же награду дважды в день апдейта.
          if (_retentionState.streakRewards[_retentionState.streakLen]) {
            _ladderState.claimedDay = _todayKey();
          }
        }
        var _ladderAdvance = Ladder.advance(_ladderState, _todayKey());
        _ladderState = _ladderAdvance.state;
        if (_ladderAdvance.opened) _ladderPending = true;
      }

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
      refreshCosmeticOwnership();

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
      maxReachedIndex: _maxReachedPos,
      posLock:         true, // ТЗ №50: с этой сборки maxReachedIndex — всегда позиция
      postcards:       _postcards,
      chaptersUnlocked: _chaptersUnlocked,
      bonusHints:      _bonusHints,
      retention:       (typeof Retention !== 'undefined' && _retentionState)
                          ? Retention.encodeState(_retentionState) : null,
      // ТЗ №49: поля лестницы — плоские, без encode/decode (см. ladder.js).
      ladderDay:        _ladderState.day,
      ladderLastDay:    _ladderState.lastDay,
      ladderSeries:     _ladderState.series,
      ladderClaimedDay: _ladderState.claimedDay,
      hooksShown:       _hooksShown,
    };
    // Сторож байтов (ЖЁСТКОЕ ОГРАНИЧЕНИЕ задания): при риске переполнения
    // площадка-специфичного лимита (Platform.SAVE_SIZE_GUARD_BYTES) вытесняет
    // boardStates, никогда прогресс.
    Platform.save(Save.enforceSizeGuard(payload, Platform.SAVE_SIZE_GUARD_BYTES));
  }

  /* ---- ТЗ №01: модуль удержания — рантайм-обвязка ----
     retention.js сам ничего не знает про DOM/Platform/LEVELS (см. заголовок
     файла) — весь мост здесь. Каждая функция начинается с typeof-проверки,
     чтобы в яндекс-сборке (retention.js не подключён) всё было тихим no-op,
     а не ReferenceError (тот же приём, что showDailyGame()/DAILY_LEVELS,
     ТЗ №01 п.1.5). */

  var _retentionToastTimer = null;

  function showRetentionToast(text) {
    var el = document.getElementById(RETENTION_CONFIG.domSlots.rewardToast);
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    // requestAnimationFrame — чтобы .hidden->false и добавление класса не
    // схлопнулись в один кадр (иначе CSS-transition не сыграет).
    requestAnimationFrame(function () { el.classList.add('is-visible'); });
    if (_retentionToastTimer) clearTimeout(_retentionToastTimer);
    _retentionToastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
      setTimeout(function () { el.hidden = true; }, 260); // дождаться transition
    }, 3200);
  }

  // ТЗ №51а: тост «почти собрал» (1-3 клетки) живёт 3.2с, а последние
  // клетки игрок обычно ставит за 1-3с — тост доживает до открытия
  // #win-overlay. Вызывается ДО показа оверлея победы (main.js::onWin и
  // showDailyWinOverlay), убирает тост сразу, без transition — оверлей
  // победы и так перекрывает экран. Тосты, которые показывает уже сам
  // оверлей победы (лестница, «+3 подсказки», «Опубликовано»), идут
  // ПОСЛЕ этого вызова через showRetentionToast как обычно.
  function hideRetentionToast() {
    var el = document.getElementById(RETENTION_CONFIG.domSlots.rewardToast);
    if (!el) return;
    if (_retentionToastTimer) { clearTimeout(_retentionToastTimer); _retentionToastTimer = null; }
    el.classList.remove('is-visible');
    el.hidden = true;
  }

  // RV-загрузка (2026-09-06, баг-репорт основателя): Platform.showRewarded
  // может занять до 40с (REWARD_AD_TIMEOUT_MS/AD_HANG_TIMEOUT_MS, оба
  // адаптера) — без явного индикатора это неотличимо от зависшей игры.
  // Пара функций оборачивает КАЖДЫЙ вызов showRewarded (onHintClick,
  // onRewardedButtonClick) — единая точка, а не дублированная логика на
  // каждом сайте вызова. #ad-loading-overlay НЕ прячет и не дизейблит
  // саму кнопку/экран под собой (п.190/шрам Color Sort остаётся в силе) —
  // это отдельный, временный, явный слой поверх.
  function showAdLoadingOverlay() {
    var el = document.getElementById('ad-loading-overlay');
    if (el) el.hidden = false;
  }
  function hideAdLoadingOverlay() {
    var el = document.getElementById('ad-loading-overlay');
    if (el) el.hidden = true;
  }

  // Защита от повторной отправки (2026-09-07, живой скриншот основателя с
  // реального Android + тот же паттерн у game3/color_sort той же ночью):
  // пока предыдущий Platform.showRewarded не вернул исход, повторный клик
  // по ЛЮБОЙ из двух RV-кнопок (#btn-hint, #retention-rewarded-btn) —
  // Platform.showRewarded один на оба сайта вызова — молча игнорируется
  // (с записью в лог), не уходит вторым вызовом показа rewarded-ролика,
  // который площадка маршрутизирует по общему каналу ответов (минимум
  // неопределённое поведение).
  //
  // ВАЖНО: гейт — это ТОЛЬКО внутренний флаг, кнопки физически НЕ
  // дизейблятся (нет .disabled = true нигде здесь). tools/test_
  // rewarded_loading_ui.js жёстко проверяет обратное: «п.190/шрам Color
  // Sort: кнопка НЕ дизейблена во время ожидания» — прошлый инцидент, когда
  // задизейбленная на время ожидания кнопка привела к худшему UX, чем
  // отсутствие защиты. Здесь тот же принцип соблюдён: игрок видит активную
  // кнопку и МОЖЕТ по ней кликать, просто повторные клики в это окно
  // молча не уходят в сеть второй раз — сеть, не интерфейс.
  var _rewardedGateOpen = true;
  function lockRewardedGate() {
    _rewardedGateOpen = false;
  }
  function unlockRewardedGate() {
    _rewardedGateOpen = true;
  }

  // Яндекс 4.5.1 (усиление 2026-09-06, прямая просьба основателя после
  // первого текстового фикса маркера): текста «Смотреть рекламу» мало —
  // нужен ещё и значок, читаемый как «реклама» с первого взгляда, отдельно
  // от текста. Один SVG на обе RV-точки (кружок + плашка-«экран» с
  // треугольником — узнаваемый паттерн «видео», не спутать с ▶ обычного
  // hint). currentColor не берём — заливка фиксирована через var(--accent),
  // чтобы значок не терялся на любой из 4 цветовых тем магазина (Задача I).
  function adIconHtml() {
    return '<svg class="ad-icon" viewBox="0 0 16 16" width="15" height="15" ' +
      'aria-hidden="true" focusable="false">' +
      '<rect x="0.5" y="2.5" width="15" height="11" rx="2.5"/>' +
      '<path d="M6.4 5.6v4.8l4.6-2.4z"/>' +
      '</svg>';
  }

  // ТЗ №49: #retention-streak-line больше не показывается (заменена
  // #series-line, см. renderSeriesLine ниже) — элемент остаётся в DOM
  // (index.html: build.py insert_retention_dom), main.js его только прячет.
  // Функция-заглушка оставлена (не удалена) — на случай отката/A-B теста
  // формулировки, тем же способом, что и streakDayReward:{} выше.
  function renderRetentionStreakLine() {
    var el = document.getElementById(RETENTION_CONFIG.domSlots.streakLine);
    if (el) el.hidden = true;
  }

  // ТЗ №49, §2.3: «Серия: {n} дн. · день {d} из 7» на месте старой строки
  // серии входов. day=0 (лестница ещё ни разу не открывалась — самый
  // первый показ меню до первого onEnter) — строка скрыта, показывать
  // «день 0 из 7» игроку нечего.
  function renderSeriesLine() {
    var el = document.getElementById('series-line');
    if (!el) return;
    if (!_ladderState || _ladderState.day <= 0) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = I18N.t('seriesLine')
      .replace('{n}', _ladderState.series)
      .replace('{d}', _ladderState.day);
  }

  /* ---- ТЗ №49: лестница 7 дней (карточка #ladder-card) ----
     ladder.js сам ничего не знает про DOM/Platform/COSMETICS (см. заголовок
     файла) — весь мост, как и у retention.js, здесь. */

  function trackEvent(name, params) {
    if (Platform.track) Platform.track(name, params);
  }

  // ТЗ №54: вибрация идёт за тем же переключателем, что и звук — один
  // понятный игроку тумблер «тихо».
  function haptic(kind) {
    if (!_muted && Platform.haptic) Platform.haptic(kind);
  }

  function onLineClosedFx() {
    Sound.lineClosed();
    haptic('light');
  }

  // ТЗ №54: прогресс победы записывается сразу, а экран победы — после
  // финальной волны по полю (Nonogram.playWinWave), иначе оверлей её
  // закрывает. «Назад» в эти доли секунды отменяет только показ.
  var WIN_REVEAL_DELAY_MS = 650;
  var _winRevealTimer = null;
  function scheduleWinReveal(fn) {
    cancelWinReveal();
    _winRevealTimer = setTimeout(function () { _winRevealTimer = null; fn(); }, WIN_REVEAL_DELAY_MS);
  }
  function cancelWinReveal() {
    if (_winRevealTimer) { clearTimeout(_winRevealTimer); _winRevealTimer = null; }
  }

  // 💡 подсказки / 🎨 стиль (п.2.3). День 7 (стиль ЕЩЁ не куплен И
  // подсказки разом) — стиль заметнее подсказок.
  function ladderRewardIcon(reward) {
    if (reward.style) return '🎨';
    return '💡';
  }

  // Текст «Сегодня: {r}»/«Завтра: {r}» — день 7 может нести СРАЗУ стиль
  // (если не куплен) И подсказки (см. ladder.js LADDER[6]); ТЗ не описывает
  // отдельную комбинированную формулировку — склеиваем части через " + ",
  // не теряя ни одной награды дня в тексте карточки.
  function ladderRewardText(reward) {
    var parts = [];
    if (reward.style) {
      parts.push(I18N.t(reward.style === 'cosmetic_night' ? 'rewardStyleNight' : 'rewardStyleRust'));
    }
    if (reward.hints > 0) {
      var word = I18N.pluralRu(reward.hints, [I18N.t('rewardHintsOne'), I18N.t('rewardHintsFew'), I18N.t('rewardHintsMany')]);
      parts.push('+' + reward.hints + ' ' + word);
    }
    return parts.join(' + ');
  }

  // Тост при «Забрать» — переиспользует существующие ключи
  // retentionRewardHints/retentionRewardStyle (ТЗ №49, п.2.3). Приоритет при
  // комбинированной награде дня 7: стиль > подсказки — тот же порядок, что и
  // у значка (ladderRewardIcon).
  function ladderToastText(reward) {
    if (reward.style) return I18N.t('retentionRewardStyle');
    if (reward.hints > 0) return retentionRewardHintsText(reward.hints);
    return '';
  }

  function renderLadderStrip(day) {
    var strip = document.getElementById('ladder-card-strip');
    if (!strip) return;
    strip.innerHTML = '';
    for (var i = 1; i <= 7; i++) {
      var reward = Ladder.rewardFor(i, _cosmeticsOwned);
      var cell = document.createElement('div');
      cell.className = 'ladder-cell' + (i < day ? ' is-done' : (i === day ? ' is-current' : ''));
      var num = document.createElement('span');
      num.className = 'ladder-cell-num';
      num.textContent = String(i);
      var icon = document.createElement('span');
      icon.className = 'ladder-cell-icon';
      icon.textContent = ladderRewardIcon(reward);
      cell.appendChild(num);
      cell.appendChild(icon);
      strip.appendChild(cell);
    }
  }

  function showLadderCard() {
    var day = _ladderState.day;
    var tomorrowDay = (day >= 7) ? 4 : day + 1; // тот же приём по кругу, что Ladder.advance
    var todayReward    = Ladder.rewardFor(day, _cosmeticsOwned);
    var tomorrowReward = Ladder.rewardFor(tomorrowDay, _cosmeticsOwned);

    document.getElementById('ladder-card-title').textContent =
      I18N.t('ladderTitle').replace('{n}', _ladderState.series);
    document.getElementById('ladder-card-day').textContent =
      I18N.t('ladderDay').replace('{d}', day);
    renderLadderStrip(day);
    document.getElementById('ladder-card-today').textContent =
      I18N.t('ladderToday').replace('{r}', ladderRewardText(todayReward));
    document.getElementById('ladder-card-tomorrow').textContent =
      I18N.t('ladderTomorrow').replace('{r}', ladderRewardText(tomorrowReward));

    document.getElementById('btn-ladder-claim').onclick = function () {
      claimLadderReward(todayReward);
    };

    document.getElementById('ladder-card').hidden = false;
    trackEvent('card_shown', { day: day });
  }

  function claimLadderReward(reward) {
    if (reward.hints > 0) {
      _bonusHints += reward.hints;
      updateHintBadge();
      updateCheckButton();
    }
    if (reward.style && !_cosmeticsOwned[reward.style]) {
      _cosmeticsOwned[reward.style] = true;
    }
    var toastText = ladderToastText(reward);
    if (toastText) showRetentionToast(toastText);

    _ladderState.claimedDay = _todayKey();
    _ladderPending = false;
    saveProgress();

    document.getElementById('ladder-card').hidden = true;
    trackEvent('card_claimed', { day: _ladderState.day });
  }

  // Вызывается в showMenu() при каждом показе меню (не только «первый раз
  // после загрузки» буквально — карточка без кнопки «Позже», п.2.3, поэтому
  // естественно переоткрывается, пока не забрана; Ladder.isClaimed делает
  // это идемпотентным — за один день покажется, только пока не нажали
  // «Забрать»).
  function maybeShowLadderCard() {
    if (typeof Ladder === 'undefined' || !_ladderPending) return;
    if (Ladder.isClaimed(_ladderState, _todayKey())) { _ladderPending = false; return; }
    showLadderCard();
  }

  // ТЗ №03, Фаза 1: видимый баланс бонусных подсказок (находка ТЗ №02 —
  // награда 2-го дня жила только 3с тоста и пропадала бесследно). Общий
  // код (main.js — файл общий для Яндекса и ВК). До ТЗ №26 на Яндексе была
  // функционально инертна (_bonusHints всегда 0, retention.js не подключён)
  // — с Этапа 3 отображается на обеих площадках одинаково. Без знаменателя
  // (только число, без «из N») — п.2.4/«ЧЕГО НЕ ДЕЛАТЬ» ТЗ №01.
  //
  // Яндекс 4.5.1 (замечание модерации 2026-09-06, три захода — основатель
  // явно отверг первые два как "переделать"). Заход №1: значок «экран+play»
  // появлялся только ПОСЛЕ исчерпания баланса — сам переход ощущался как
  // неожиданность. Заход №2: значок стал постоянным + бейдж-счётчик на его
  // углу — но подпись при исчерпании ПОЛНОСТЬЮ заменялась на «Смотреть
  // рекламу», из-за чего кнопка среди «Закрасить»/«Крестик» переставала
  // читаться как подсказка вообще (игрок видел ряд из трёх инструментов, и
  // третий внезапно писал про рекламу — ни слова «подсказка»). Заход №3
  // (текущий): подпись `[data-i18n="hint"]` ПОСТОЯННАЯ — «Подсказка», не
  // переключается никогда, это и есть главный посыл кнопки. Факт рекламы —
  // вторичная, более мелкая подпись `#hint-ad-caption` («за рекламу»),
  // видимая (visibility, не hidden — резервирует высоту, чтобы кнопка не
  // прыгала в размере между состояниями и не тянула за собой .mode-bar,
  // см. style.css) ТОЛЬКО когда клик реально уйдёт в Platform.showRewarded
  // (см. onHintClick, ветка else). Бейдж-счётчик (#hint-badge, на углу
  // постоянного значка) — не изменился: N бесплатных попыток, живо считает
  // вниз, ноль сознательно не показывается (решение ТЗ №03/№12).
  function updateHintBadge() {
    var badge = document.getElementById('hint-badge');
    if (badge) {
      if (_bonusHints > 0) {
        badge.textContent = String(_bonusHints);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }
    var caption = document.getElementById('hint-ad-caption');
    if (caption) caption.classList.toggle('is-visible', _bonusHints <= 0);
  }

  function _formatClock(d) {
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    return hh + ':' + mm;
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
  function _dayKeyFromDate(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function _todayKey() {
    return _dayKeyFromDate(Platform.now());
  }

  // ТЗ №49, §3: локальная «завтра» — тот же способ, что и «сегодня»
  // (Platform.now(), не UTC), просто +1 календарный день.
  function _tomorrowDate() {
    var now = Platform.now();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
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

  // ТЗ №49, §3: необязательный параметр date (по умолчанию — Platform.now())
  // для тизера завтрашнего пазла (renderWinTomorrow) — логика не меняется,
  // просто считаем от переданной даты вместо всегда «сегодня».
  function _dailyIndex(date) {
    var dayKey      = _dayKeyFromDate(date || Platform.now());
    var days        = Math.round((_dayAnchor(dayKey)              - _dayAnchor('2024-1-1')) / 86400000);
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
    // Решённое поле — не черновик: onWin уже стёр его из сейва. Без этой
    // проверки сворачивание ВК при открытом экране победы (или «Назад» до
    // его показа) записывало решённую доску обратно в boardStates.
    if (Nonogram.isWon()) return;
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
  // показать каждый 6-й пройденный уровень (кампания и ежедневный вместе;
  // ТЗ №09 фаза 2 — было 2, реже по решению основателя), и не чаще, чем раз
  // в 75 с реального времени (требование: кулдаун 60-90с, 75с — середина
  // диапазона, из ТЗ №09 не менялось). На время показа звук и игра на паузе.
  var INTERSTITIAL_LEVEL_INTERVAL = 6;
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
    if (Platform.gameplayStop) Platform.gameplayStop(); // ТЗ №49, п.5: перед interstitial
    Platform.showInterstitial(function () {
      Nonogram.setPaused(false);
      Sound.resume();
      onDone();
    });
  }

  /* ---- Хелперы глав (ТЗ №50, «Альбом») ---- */

  function chapterOfIndex(levelIndex) {
    for (var i = 0; i < CHAPTERS.length; i++) {
      if (CHAPTERS[i].indices.indexOf(levelIndex) >= 0) return CHAPTERS[i];
    }
    return null;
  }

  // Первый непройденный уровень главы; если все пройдены — первый в главе
  function firstUnfinishedInChapter(ch) {
    for (var i = 0; i < ch.indices.length; i++) {
      if (!_completedLevels[ch.indices[i]]) return ch.indices[i];
    }
    return ch.indices[0];
  }

  function countCompletedInChapter(ch) {
    var n = 0;
    for (var i = 0; i < ch.indices.length; i++) {
      if (_completedLevels[ch.indices[i]]) n++;
    }
    return n;
  }

  /* ---- Замок глав (2026-09-25, решение основателя) ----
     Глава открывается ПРОГРЕССОМ: решено CHAPTER_UNLOCK_NEED картинок
     предыдущей главы — или досрочно за рекламу (_chaptersUnlocked).
     В открытой главе доступны сразу все 10 картинок. Таймер раздатчика
     (retention.js, «+6 каждые 6 часов», ТЗ №08) главы больше не открывает:
     он открывал картинки по порядку глав независимо от игры — игрок,
     решивший 5 картинок, через сутки видел открытыми 3,5 главы.
     retention.js по-прежнему подключён — считает серию входов (streakLen)
     для миграции на лестницу, его состояние пишется в сейв как раньше. */
  var CHAPTER_UNLOCK_NEED = 7;

  // Глава «достигнута» без проверки предыдущей: открыта за рекламу или уже
  // начата (игрок из прежней схемы (таймер) мог решать в ней, не набрав 7
  // в предыдущей) — такая глава не запирается обратно.
  function isChapterReached(ch) {
    return !!_chaptersUnlocked[ch.key] || countCompletedInChapter(ch) > 0;
  }

  function isChapterOpen(chIdx) {
    var ch = CHAPTERS[chIdx];
    if (!ch) return false;
    if (chIdx === 0) return true;
    // Открыта любая следующая глава — открыты и все предыдущие (замечание
    // основателя 25.09: у игрока прежней схемы глава 4 висела запертой
    // между открытыми 3 и 7, а 5–6 были скрыты вовсе).
    for (var j = chIdx; j < CHAPTERS.length; j++) {
      if (isChapterReached(CHAPTERS[j])) return true;
    }
    return countCompletedInChapter(CHAPTERS[chIdx - 1]) >= CHAPTER_UNLOCK_NEED;
  }

  function isLevelIndexOpen(levelIndex) {
    if (_completedLevels[levelIndex]) return true;
    var ch = chapterOfIndex(levelIndex);
    return !ch || isChapterOpen(CHAPTERS.indexOf(ch));
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
    trackEvent('menu_shown');
    if (typeof Retention !== 'undefined') renderRetentionStreakLine();
    renderSeriesLine();
    maybeShowLadderCard();

    var btnContinue = document.getElementById('btn-continue');
    var hasContinue = (_lastLevelIndex >= 0);
    btnContinue.hidden = !hasContinue;

    // onclick заменяет предыдущий обработчик — не накапливается при повторных вызовах
    document.getElementById('btn-play').onclick = function () {
      Sound.resumeContext();
      // ТЗ №49, п.4 («Первые 60 секунд»): игрок без единого пройденного
      // уровня идёт СРАЗУ в игру (уровень 0), минуя экран глав —
      // карточка «Как читать числа» показывается только один раз
      // (!_onboardingSeen), иначе прямо в уровень.
      if (Object.keys(_completedLevels).length === 0) {
        trackEvent('first_puzzle_started');
        if (!_onboardingSeen) {
          showOnboarding(function () { showGame(0); });
        } else {
          showGame(0);
        }
      } else {
        showChapters();
      }
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

    // ТЗ №49, §2.3: «Пазлов подряд» (серия ежедневного режима, отдельная
    // от лестницы механика) больше не показывается в меню — остаётся в
    // подписи экрана пазла дня (showDailyGame) и в заголовке календаря
    // (showCalendar), чтобы информация не терялась, а не дублировалась
    // рядом с новой #series-line.
    document.getElementById('daily-streak').hidden = true;

    document.getElementById('btn-calendar').onclick = function () {
      showCalendar();
    };

    // ТЗ №07, фаза 3.2: до гейта (COSMETIC_UNLOCK_LEVELS пройдено) экран
    // магазина — одна строка про гейт и пустота, ничего не продаёт и
    // выглядит сломанным. Дешевле скрыть пункт меню, чем рисовать силуэты
    // товаров — согласуется со стандартом «витрина выводится из
    // возможности» (см. фазу 3.3).
    var btnShop = document.getElementById('btn-shop');
    var shopUnlocked = Object.keys(_completedLevels).length >= COSMETIC_UNLOCK_LEVELS;
    btnShop.hidden = !shopUnlocked;
    btnShop.onclick = function () {
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

  // Владение КУПЛЕННОЙ косметикой — ПОСТОЯННАЯ покупка (принятая модель
  // совета): consumePurchase() на ней НЕ вызывается никогда, право
  // владения — это ответ payments.getPurchases(). Вызывается на КАЖДОМ
  // старте игры (см. вызов ниже сразу после Platform.load()). Поле id
  // товара в ответе — ИМЕННО productID, не id (сверено с докой Yandex
  // Games SDK, sdk-purchases, 25.07.2026; getCatalog() использует id —
  // это разные структуры).
  //
  // Награды серии входов (cos.streakReward) — НЕ товар, getPurchases() их
  // никогда не вернёт (Яндекс о них не знает), поэтому синк с платформой
  // их не касается вообще: раз выданные Retention.grantStyle(), они не
  // отбираются синком владения (см. tools/test_retention_live.js — 3-й
  // день серии остаётся в сейве и после сброса серии).
  //
  // Фолбэк: если getPurchases() упал (сеть/SDK), владение НЕ трогаем —
  // остаётся локальное зеркало последнего успешного ответа (_cosmeticsOwned
  // из сейва). Игрок, однажды купивший стиль, не теряет его при плохой сети.
  // Причину сбоя логируем громко (не глотаем).
  //
  // ТЗ №20: площадка БЕЗ покупок (Platform.paymentsAvailable === false,
  // сейчас ВК) НЕ является источником истины о владении — там покупок нет
  // вообще, а не «нет покупок у этого игрока». adapters/vk_bridge.js
  // отвечает {ok:true, purchases:[]} (не ошибка, честная заглушка), и без
  // этой проверки такой ответ синк трактовал бы как «Яндекс подтвердил:
  // ничего не куплено» и стирал бы владение — тот же путь срабатывал и
  // после init-таймаута адаптера (available=false), потому что заглушка
  // его не проверяет вовсе. Синк имеет смысл только там, где реальный
  // ответ платформы вообще существует.
  function refreshCosmeticOwnership() {
    if (!Platform.paymentsAvailable) return;

    Platform.getPurchases().then(function (res) {
      if (!res.ok) {
        console.error('[main] getPurchases() упал — используется локальное зеркало покупок (владение не снимается). Причина:', res.error);
        return;
      }
      var ownedNow = {};
      COSMETICS.forEach(function (cos) {
        // Награды серии входов живут вне payments — переносим как есть.
        if (cos.streakReward && _cosmeticsOwned[cos.id]) ownedNow[cos.id] = true;
      });
      res.purchases.forEach(function (p) {
        for (var i = 0; i < COSMETICS.length; i++) {
          if (COSMETICS[i].id === p.productID && !COSMETICS[i].streakReward) { ownedNow[p.productID] = true; break; }
        }
      });
      var changed = false;
      COSMETICS.forEach(function (cos) {
        if (!cos.id || cos.streakReward) return; // база бесплатна/не товар — синку не подлежат
        if (!!_cosmeticsOwned[cos.id] !== !!ownedNow[cos.id]) changed = true;
      });
      // Если снятое владение — это ПРИМЕНЁННАЯ прямо сейчас тема, откат
      // должен быть виден игроку как событие (тема реально перекрашивается
      // на экране), а не как расхождение, которое он бы обнаружил только
      // сам, зайдя в магазин и увидев «Купить» вместо «Убрать» (ТЗ №20).
      var activeStripped = !!_activeCosmetic && !!_cosmeticsOwned[_activeCosmetic] && !ownedNow[_activeCosmetic];
      // Ответ Яндекса — новое зеркало для купленной косметики (перезаписываем
      // целиком): «владеет, если сказал Яндекс», см. постановку.
      _cosmeticsOwned = ownedNow;
      if (activeStripped) {
        _activeCosmetic = '';
        applyCosmetic('');
        changed = true;
      }
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
    // 2026-09-25, замечание основателя: у того, что уже есть, «Примерить»
    // не нужна — сразу «Применить»; у недоступного — только «Примерить».
    if (!owned) {
      var previewBtn = document.createElement('button');
      previewBtn.className = 'btn btn-secondary';
      previewBtn.textContent = I18N.t('shopPreview');
      previewBtn.onclick = function () { applyThemeClass(cos.themeClass); };
      actions.appendChild(previewBtn);
    }

    var mainBtn = document.createElement('button');
    mainBtn.className = 'btn btn-primary';

    if (owned) {
      statusEl.textContent = cos.free ? I18N.t('shopDefault')
        : (cos.streakReward ? I18N.t('shopStreakReward') : I18N.t('shopOwned'));
      // Применённая гамма — неактивная отметка, а не «Выключить»: вернуться к
      // другой гамме можно её же кнопкой «Применить» (база всегда в списке),
      // отдельная кнопка отмены дублировала бы это действие.
      mainBtn.textContent = I18N.t(applied ? 'shopApplied' : 'shopApply');
      mainBtn.disabled = applied;
      if (!applied) {
        mainBtn.onclick = function () {
          _activeCosmetic = cos.id;
          applyCosmetic(_activeCosmetic);
          saveProgress();
          showShop(); // перерисовать метки кнопок под новое состояние
        };
      }
    } else if (cos.streakReward) {
      // ТЗ №01, п.2.3: НЕ товар — покупке не подлежит ни при каком catalogMap,
      // выдаётся только за серию входов (лестница). Условие получения уже
      // написано в статусе под названием — отдельная неактивная кнопка с тем
      // же текстом была дублем (замечание основателя 2026-09-25).
      statusEl.textContent = I18N.t('shopStreakLocked');
      mainBtn = null;
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
        // Цена цифрами + иконка портальной валюты (п.1.13.2/1.13.4) —
        // product.price уже приходит отформатированным из getCatalog(),
        // иконку берём из IProduct.getPriceCurrencyImage('small'). Название
        // и символ валюты своими не заменяем — только то, что дал SDK.
        statusEl.textContent = '';
        mainBtn.textContent = '';
        mainBtn.appendChild(document.createTextNode(I18N.t('shopBuy') + ' — ' + product.price + ' '));
        if (typeof product.getPriceCurrencyImage === 'function') {
          try {
            var currencyUrl = product.getPriceCurrencyImage('small');
            if (currencyUrl) {
              var currencyImg = document.createElement('img');
              currencyImg.className = 'shop-currency-icon';
              currencyImg.src = currencyUrl;
              currencyImg.alt = '';
              mainBtn.appendChild(currencyImg);
            }
          } catch (e) {
            console.error('[main] getPriceCurrencyImage ошибка:', e);
          }
        }
        mainBtn.disabled = false;
        mainBtn.onclick = function () {
          mainBtn.disabled = true;
          Platform.purchase(cos.id).then(function (result) {
            if (!result) {
              mainBtn.disabled = false; // отмена/ошибка — даём попробовать ещё раз
              return;
            }
            // Покупка навсегда: consumePurchase() на косметике НЕ вызываем
            // (принятая модель — постоянная покупка). Право владения на
            // следующих стартах подтвердит getPurchases() (см.
            // refreshCosmeticOwnership); здесь просто оптимистично
            // отражаем результат сразу, не дожидаясь рестарта.
            _cosmeticsOwned[cos.id] = true;
            _activeCosmetic = cos.id;
            applyCosmetic(_activeCosmetic);
            saveProgress();
            showShop();
          });
        };
      }
    }

    if (mainBtn) actions.appendChild(mainBtn);
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
    // ТЗ №07, фаза 3.3: платежи на ВК не подключены (Platform.paymentsAvailable
    // === false) — состояние «витрина видна, купить нельзя» обязано быть
    // невыразимым (стандарт студии 18.08), поэтому платные ряды (не free,
    // не streakReward) в такой сборке не рисуются вовсе, а не дизейблятся.
    // Код покупок не удалён — на Яндексе (paymentsAvailable:true) ряды
    // остаются, поведение не меняется.
    var shownCosmetics = Platform.paymentsAvailable
      ? COSMETICS
      : COSMETICS.filter(function (cos) { return cos.free || cos.streakReward; });

    shownCosmetics.forEach(function (cos) {
      listEl.appendChild(buildShopItemRow(cos, null)); // null = каталог ещё не пришёл
    });

    Platform.getCatalog().then(function (catalog) {
      if (!document.getElementById('shop').classList.contains('is-active')) return; // экран уже закрыт
      var catalogMap = {};
      catalog.forEach(function (p) { catalogMap[p.id] = p; });
      listEl.innerHTML = '';
      shownCosmetics.forEach(function (cos) {
        listEl.appendChild(buildShopItemRow(cos, catalogMap));
      });
    });
  }

  /* ---- Экран глав («Альбом», ТЗ №50) ---- */

  // Первый непройденный уровень главы, если глава открыта; null — глава
  // заперта (или вся пройдена).
  function firstOpenUnfinishedInChapter(ch) {
    if (!isChapterOpen(CHAPTERS.indexOf(ch))) return null;
    for (var i = 0; i < ch.indices.length; i++) {
      if (!_completedLevels[ch.indices[i]]) return ch.indices[i];
    }
    return null;
  }

  // Строка запертой главы: «Решите ещё {n} {word} в главе {k}» — ровно то,
  // что её откроет (раньше «Откроется через N пазлов» означало «таймер
  // выдаст ещё N», а читалось как «решите N»).
  function chapterLockedLineText(chIdx) {
    var prev = CHAPTERS[chIdx - 1];
    var n = Math.max(1, CHAPTER_UNLOCK_NEED - countCompletedInChapter(prev));
    var word = I18N.pluralRu(n, [I18N.t('pictureWordOne'), I18N.t('pictureWordFew'), I18N.t('pictureWordMany')]);
    return I18N.t('chapterLocked')
      .replace('{n}', n)
      .replace('{word}', word)
      .replace('{k}', chIdx);
  }

  // Кнопка «Открыть главу сейчас» за rewarded — прямо на карточке запертой
  // главы (замечание основателя 2026-09-25: надпись обещала рекламу, а тап
  // по главе ролик не запускал). Та же обвязка, что у подсказки за рекламу:
  // оверлей загрузки + гейт от повторного клика; кнопка не дизейблится
  // (п.190, шрам Color Sort — см. lockRewardedGate).
  function onChapterUnlockAdClick(ch) {
    window.debugLog('click: .chapter-unlock-btn ' + ch.key);
    if (!_rewardedGateOpen) {
      window.debugLog('click: .chapter-unlock-btn проигнорирован — предыдущий запрос ещё в полёте');
      return;
    }
    Sound.resumeContext();
    showAdLoadingOverlay();
    lockRewardedGate();
    if (Platform.gameplayStop) Platform.gameplayStop();
    var granted = false;
    Platform.showRewarded(function onReward() {
      if (_chaptersUnlocked[ch.key]) return;
      _chaptersUnlocked[ch.key] = true;
      granted = true;
      saveProgress();
      trackEvent('chapter_unlock_ad', { chapter: ch.key });
    }, function onClose() {
      unlockRewardedGate();
      hideAdLoadingOverlay();
      if (!document.getElementById('chapters').classList.contains('is-active')) return;
      showChapters();
      if (granted) {
        showRetentionToast(I18N.t('chapterUnlockedToast').replace('{name}', I18N.t(ch.nameKey)));
      }
    });
  }

  function _reduceMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Статичный (без анимации) силуэт для миниатюр главы/открытки за главу —
  // тем же способом, что buildSilhouette (Задача G), но без juice-анимации
  // «проявления» — там она смысловая (победа ЭТОГО уровня), здесь просто
  // маленькая метка «эта картинка пройдена».
  function paintSilhouetteStatic(canvas, level, maxPx, noGap) {
    var W = level.width, H = level.height;
    var CELL = Math.max(1, Math.min(48, Math.floor((maxPx || 260) / Math.max(W, H))));
    canvas.width  = W * CELL;
    canvas.height = H * CELL;
    var ctx = canvas.getContext('2d');
    var style = getComputedStyle(document.documentElement);
    var bg  = style.getPropertyValue('--bg').trim()  || '#f3ead6';
    var ink = style.getPropertyValue('--ink').trim() || '#2b2723';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink;
    // Зазор между клетками — только когда клетка достаточно крупная. Раньше
    // зазор был всегда по 1px с каждой стороны: при CELL=2 (картинки 10×10–
    // 13×13 в миниатюре) ширина клетки выходила 0 и миниатюра рисовалась
    // пустой — с главы 2 почти все пройденные картинки были пустыми клетками.
    // Миниатюры альбома (noGap) — всегда сплошные: иначе при масштабе
    // экрана 125%+ картинки 5×5 (клетка ≥6) выходили «в точку», а 6×6 и
    // крупнее в той же главе — сплошными (замечание основателя 25.09).
    var gap = (!noGap && CELL >= 6) ? 1 : 0;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (level.solution[r][c]) ctx.fillRect(c * CELL + gap, r * CELL + gap, CELL - 2 * gap, CELL - 2 * gap);
      }
    }
  }

  // Одна миниатюра ряда главы — kind: 'done' | 'open'.
  function buildThumb(levelIndex, numberInChapter, kind) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb is-' + kind;
    if (kind === 'done') {
      var canvas = document.createElement('canvas');
      canvas.className = 'thumb-canvas';
      btn.appendChild(canvas);
      // Разрешение под плотность экрана: миниатюра ~28 CSS-px, на телефоне
      // с dpr 3 канвас в 26px растягивался бы в 3 раза и мылился.
      paintSilhouetteStatic(canvas, LEVELS[levelIndex], Math.round(28 * Math.min(3, window.devicePixelRatio || 1)), true);
      btn.addEventListener('click', function () { showGame(levelIndex); });
    } else {
      var num = document.createElement('span');
      num.className = 'thumb-num';
      num.textContent = String(numberInChapter);
      btn.appendChild(num);
      btn.addEventListener('click', function () { showGame(levelIndex); });
    }
    return btn;
  }

  function showChapters() {
    showScreen('chapters');

    var list = document.getElementById('chapter-list');
    list.innerHTML = '';
    var scrollTarget = null;
    // ТЗ №52: показываем открытые/пройденные главы + первую запертую по
    // порядку; запертые после неё не рендерим вовсе (счётчик — в подпись).
    var firstLockedShown = false;
    var hiddenAheadCount = 0;

    CHAPTERS.forEach(function (ch, chIdx) {
      var done  = countCompletedInChapter(ch);
      var total = ch.indices.length;
      var allDone = (done === total);

      var locked = !isChapterOpen(chIdx);
      var openTarget = firstOpenUnfinishedInChapter(ch);

      if (locked) {
        if (firstLockedShown) {
          hiddenAheadCount++;
          return;
        }
        firstLockedShown = true;
      }

      var card = document.createElement('div');
      card.className = 'chapter-card' + (locked ? ' is-locked' : '');

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'chapter-head-btn';

      var nameEl = document.createElement('span');
      nameEl.className = 'chapter-name';
      nameEl.textContent = (chIdx + 1) + ' · ' + I18N.t(ch.nameKey);

      var progEl = document.createElement('span');
      progEl.className = 'chapter-progress' + (allDone ? ' is-done' : '');
      if (locked) {
        progEl.textContent = '🔒';
      } else if (allDone) {
        progEl.textContent = '✓ ' + I18N.t('chapterProgress').replace('{k}', total);
      } else {
        progEl.textContent = I18N.t('chapterProgress').replace('{k}', done);
      }

      head.appendChild(nameEl);
      head.appendChild(progEl);
      if (_postcards[ch.key]) {
        var badge = document.createElement('span');
        badge.className = 'postcard-badge';
        badge.textContent = '✉';
        badge.setAttribute('aria-label', I18N.t('postcardLabel'));
        badge.title = I18N.t('postcardLabel');
        head.appendChild(badge);
      }
      card.appendChild(head);

      if (locked) {
        var lockLine = document.createElement('p');
        lockLine.className = 'chapter-locked-line';
        lockLine.textContent = chapterLockedLineText(chIdx);
        card.appendChild(lockLine);
        // Тап по заголовку и кнопка делают одно и то же: основатель тапал
        // именно по карточке, ожидая ролик.
        var unlockBtn = document.createElement('button');
        unlockBtn.type = 'button';
        unlockBtn.className = 'btn btn-secondary retention-rewarded-btn chapter-unlock-btn';
        // innerHTML — значок из adIconHtml() + локализованная строка, обе
        // части фиксированы разработчиком, ввода игрока здесь нет.
        unlockBtn.innerHTML = '<span class="rv-btn-inner">' + adIconHtml() + '<span>' + I18N.t('chapterUnlockAdBtn') + '</span></span>';
        unlockBtn.addEventListener('click', function () { onChapterUnlockAdClick(ch); });
        head.addEventListener('click', function () { onChapterUnlockAdClick(ch); });
        card.appendChild(unlockBtn);
      } else {
        head.addEventListener('click', function () {
          var startIdx = allDone ? firstUnfinishedInChapter(ch) : openTarget;
          if (!_onboardingSeen && chIdx === 0) {
            showOnboarding(function () { showGame(startIdx); });
          } else {
            showGame(startIdx);
          }
        });

        var thumbs = document.createElement('div');
        thumbs.className = 'chapter-thumbs';
        // Глава открыта — открыты все её картинки (запертых миниатюр внутри
        // открытой главы при замке по главам не бывает).
        ch.indices.forEach(function (idx, i) {
          thumbs.appendChild(buildThumb(idx, i + 1, _completedLevels[idx] ? 'done' : 'open'));
        });
        card.appendChild(thumbs);
      }

      // В главе 1 — дополнительная кнопка «Как играть» (ТЗ №50, п.2.5,
      // как раньше была в категории «Обучение»).
      if (chIdx === 0) {
        var howtoBtn = document.createElement('button');
        howtoBtn.type = 'button';
        howtoBtn.className = 'chapter-howto-btn';
        howtoBtn.textContent = I18N.t('howTo');
        howtoBtn.addEventListener('click', function () {
          showOnboarding(null);
        });
        card.appendChild(howtoBtn);
      }

      if (!allDone && scrollTarget === null) scrollTarget = card;

      list.appendChild(card);
    });

    var aheadEl = document.getElementById('chapters-ahead');
    if (aheadEl) {
      if (hiddenAheadCount > 0) {
        var aheadWord = I18N.pluralRu(hiddenAheadCount, [I18N.t('chapterWordOne'), I18N.t('chapterWordFew'), I18N.t('chapterWordMany')]);
        aheadEl.textContent = I18N.t('chaptersAhead')
          .replace('{n}', hiddenAheadCount)
          .replace('{word}', aheadWord);
        aheadEl.hidden = false;
      } else {
        aheadEl.hidden = true;
      }
    }

    document.getElementById('btn-back-chapters').onclick = function () {
      showMenu();
    };

    // Первая незавершённая глава — в зону видимости (ТЗ №50, п.2.6).
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ block: 'center', behavior: _reduceMotion() ? 'auto' : 'smooth' });
    }
  }

  /* ---- Календарь месяца ---- */

  function showCalendar() {
    showScreen('calendar');

    var now  = Platform.now();
    var y    = now.getFullYear();
    var m    = now.getMonth() + 1;  // 1-12

    // ТЗ №49, §2.3: «Пазлов подряд» скрыта из меню — остаётся здесь и в
    // подписи экрана пазла дня (showDailyGame), чтобы не потеряться.
    var calTitle = I18N.t('month' + m) + ' ' + y;
    if (_streak > 0) calTitle += '  •  ' + I18N.t('streakLabel').replace('{n}', _streak);
    document.getElementById('cal-title').textContent = calTitle;

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
    if (Nonogram.isWon()) return; // см. persistBoardState
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
    // ТЗ №51: очистка убирает все ошибки — таймер простоя/непрерывной
    // ошибки должен начаться заново, иначе следующая ошибка унаследует
    // старую метку времени и тост «лишняя клетка» может сработать сразу.
    _errorSince = 0;
    _lastMoveAt = Date.now();
    updateCheckButton();

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
    // ТЗ №01, п.1.5: DAILY_LEVELS не входит в ВК-сборку (build.py,
    // YANDEX_ONLY_FILES) — путь недостижим (кнопка/календарь скрыты
    // build.py), но обращение к необъявленному глобалу было бы
    // ReferenceError, если кнопку когда-нибудь покажут без возврата файла.
    if (typeof DAILY_LEVELS === 'undefined') { showMenu(); return; }
    var idx   = _dailyIndex();
    var level = DAILY_LEVELS[idx];
    if (!level) { showMenu(); return; }

    _currentLevel = -1;   // обычное сохранение доски (по levelIndex) сюда не относится
    cancelWinReveal();
    _inDailyGame  = true;
    trackEvent('daily_shown');
    if (Platform.gameplayStart) Platform.gameplayStart();
    _levelStartedAt     = Date.now();
    _hintsUsedThisLevel = 0;
    document.getElementById('win-overlay').hidden = true;
    document.getElementById('chapter-done-overlay').hidden = true;
    document.getElementById('win-chapter-line').hidden = true;
    document.getElementById('confetti-container').innerHTML = '';
    var dlabel = I18N.t('dailyLabel');
    if (_streak > 0) dlabel += '  •  ' + I18N.t('streakLabel').replace('{n}', _streak);
    document.getElementById('game-level-label').textContent = dlabel;
    document.getElementById('btn-hint').disabled = false;
    document.getElementById('btn-check').disabled = false;
    document.getElementById('level-hint').hidden = true;

    modeBtns.forEach(function (b) {
      b.classList.toggle('is-active', parseInt(b.dataset.mode, 10) === 1);
    });

    // ТЗ №51: сброс тостов/таймера простоя на вход в картинку — тот же
    // приём, что и _levelStartedAt/_hintsUsedThisLevel выше.
    _errorSince = 0;
    _lastMoveAt = Date.now();
    updateCheckButton();
    startNudgeTimer();

    showScreen('game');
    Nonogram.render(
      level,
      document.getElementById('puzzle-container'),
      function () { onDailyWin(level); },
      function ()  { Sound.tick(); scheduleDailySave(); onBoardMove(); },
      onLineClosedFx
    );

    // Прогресс восстанавливаем, только если он от СЕГОДНЯШНЕГО дня
    // (устаревший при смене дня уже сброшен при загрузке сейва).
    if (_dailyBoard && _dailyBoardDate === _todayKey()) {
      Nonogram.restoreBoard(Save.decodeBoardAny(_dailyBoard));
      // Восстановленная доска не проходит через onMove — если в ней уже
      // есть ошибки, отсчёт непрерывной ошибки начинаем со входа в экран,
      // а не с первого НОВОГО хода.
      if (Nonogram.hasErrors()) _errorSince = Date.now();
    }

    document.getElementById('btn-back').onclick = function () {
      cancelWinReveal();
      if (Platform.gameplayStop) Platform.gameplayStop();
      flushDailySave();
      _currentLevel = -1;
      _inDailyGame  = false;
      stopNudgeTimer();
      Nonogram.setPaused(false);
      Nonogram.resetZoom();
      showMenu();
    };
  }

  function onDailyWin(level) {
    Sound.win();
    haptic('success');
    hideRetentionToast();
    document.getElementById('btn-hint').disabled = true;
    document.getElementById('btn-check').disabled = true;
    stopNudgeTimer();
    if (Platform.gameplayStop) Platform.gameplayStop();
    if (_dailySaveTimer) { clearTimeout(_dailySaveTimer); _dailySaveTimer = null; }
    var today  = _todayKey();
    _streak    = _calcStreak(today, _dailyDone, _streak);  // ДО обновления _dailyDone
    _dailyDone = today;
    _dailyDays[today] = true;
    _dailyBoard     = null;   // пазл дня пройден — прогресс-черновик больше не нужен
    _dailyBoardDate = '';
    saveProgress();
    trackEvent('daily_done', { sec: Math.round((Date.now() - _levelStartedAt) / 1000), hints: _hintsUsedThisLevel });

    scheduleWinReveal(function () {
      buildSilhouette(level);
      document.getElementById('win-theme-label').textContent = I18N.t(level.theme);
      hideRetentionToast(); // ТЗ №51а: снять тост «почти собрал» ДО показа оверлея победы
      document.getElementById('win-overlay').hidden = false;
      launchConfetti();
      if (renderWinTomorrow()) trackEvent('teaser_shown');
      updateShareButton(level, I18N.t('storyDaily').replace('{date}', storyDailyDateLabel()), -1);

      document.getElementById('btn-next-level').textContent = I18N.t('backToMenu');
      document.getElementById('btn-next-level').onclick = function () {
        _currentLevel = -1;
        _inDailyGame  = false;
        maybeShowInterstitial(showMenu);
      };
    });
  }

  /* ---- Экран игры ---- */

  function showGame(levelIndex) {
    var level = LEVELS[levelIndex];
    if (!level) { showChapters(); return; }

    // Замок — авторитетная проверка именно здесь (не только в клик-
    // хендлерах экрана глав): «Продолжить»/следующий уровень после победы
    // могут целиться в картинку ещё запертой главы.
    if (!isLevelIndexOpen(levelIndex)) {
      showChapters();
      return;
    }

    cancelWinReveal();
    _currentLevel   = levelIndex;
    _lastLevelIndex = levelIndex;  // всегда обновляем для «Продолжить»
    _inDailyGame    = false;
    // Монотонный «докуда добрался» для правила 2 замка (ТЗ №01) — НЕ то же
    // самое, что _lastLevelIndex (тот может двигаться нелинейно между
    // главами, см. onWin). Открывать/запирать это поле умеет только расти.
    if (typeof Retention !== 'undefined') _maxReachedPos = Math.max(_maxReachedPos, ChaptersMap.indexToPos(levelIndex));

    // ТЗ №49, п.5: gameplayStart() при входе в картинку, track(puzzle_done)
    // тайминг/счётчик подсказок — сброс на старте уровня.
    if (Platform.gameplayStart) Platform.gameplayStart();
    _levelStartedAt     = Date.now();
    _hintsUsedThisLevel = 0;

    document.getElementById('win-overlay').hidden = true;
    document.getElementById('chapter-done-overlay').hidden = true;
    document.getElementById('win-chapter-line').hidden = true;
    document.getElementById('confetti-container').innerHTML = '';
    // #game-level-label используется и здесь, и в showDailyGame() — для
    // кампании он пуст (номер/общее число уровня на экране решения не
    // показываются, см. showChapters для сводки доступных уровней).
    document.getElementById('game-level-label').textContent = '';
    document.getElementById('btn-hint').disabled = false;
    document.getElementById('btn-check').disabled = false;

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

    // ТЗ №51: сброс тостов/таймера простоя на вход в картинку.
    _errorSince = 0;
    _lastMoveAt = Date.now();
    updateCheckButton();
    startNudgeTimer();

    showScreen('game');
    Nonogram.render(
      level,
      document.getElementById('puzzle-container'),
      function () { onWin(level, levelIndex); },
      function ()  { Sound.tick(); scheduleBoardSave(levelIndex); onBoardMove(); },
      onLineClosedFx
    );

    if (_boardStates[levelIndex]) {
      Nonogram.restoreBoard(Save.decodeBoardAny(_boardStates[levelIndex]));
      // См. комментарий у аналогичного restoreBoard в showDailyGame().
      if (Nonogram.hasErrors()) _errorSince = Date.now();
    }

    document.getElementById('btn-back').onclick = function () {
      cancelWinReveal();
      if (Platform.gameplayStop) Platform.gameplayStop();
      flushBoardSave(levelIndex);
      _currentLevel = -1;
      stopNudgeTimer();
      Nonogram.setPaused(false);
      Nonogram.resetZoom();
      showChapters();
    };
  }

  /* ---- Победа ---- */

  function onWin(level, levelIndex) {
    Sound.win();
    haptic('success');
    hideRetentionToast();
    document.getElementById('btn-hint').disabled = true;
    document.getElementById('btn-check').disabled = true;
    stopNudgeTimer();
    if (Platform.gameplayStop) Platform.gameplayStop();

    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    delete _boardStates[levelIndex];
    // Открыла ли эта победа следующую главу (7-я картинка текущей) — для
    // тоста поверх экрана победы, чтобы открытие главы не было тихим.
    var winChIdx = CHAPTERS.indexOf(chapterOfIndex(levelIndex));
    var nextChWasOpen = winChIdx >= 0 && isChapterOpen(winChIdx + 1);
    _completedLevels[levelIndex] = true;
    var completedCount = Object.keys(_completedLevels).length;
    var unlockedChapter = (winChIdx >= 0 && !nextChWasOpen && isChapterOpen(winChIdx + 1)) ? CHAPTERS[winChIdx + 1] : null;

    // ТЗ №50: следующая позиция главы; если глава закончена — первая
    // открытая непройденная позиция СЛЕДУЮЩЕЙ главы (правило ТЗ №49 «после
    // обучения — в Лёгкие» — теперь частный случай этого же общего правила
    // для КАЖДОЙ главы, не только первой).
    var chapter = chapterOfIndex(levelIndex);
    var posInChapter = chapter ? chapter.indices.indexOf(levelIndex) : -1;
    var nextIndex = -1;
    if (chapter && posInChapter + 1 < chapter.indices.length) {
      nextIndex = chapter.indices[posInChapter + 1];
    } else if (chapter) {
      var nextChapter = CHAPTERS[CHAPTERS.indexOf(chapter) + 1];
      if (nextChapter) {
        var openNext = firstOpenUnfinishedInChapter(nextChapter);
        if (openNext !== null) nextIndex = openNext;
      }
    }

    // Награда за главу (ТЗ №50): первое завершение всех 10 картинок главы.
    var chapterJustCompleted = false;
    if (chapter && !_postcards[chapter.key]) {
      var allDoneInChapter = chapter.indices.every(function (i) { return !!_completedLevels[i]; });
      if (allDoneInChapter) chapterJustCompleted = true;
    }

    // lastLevelIndex: на следующий если есть, иначе остаёмся на текущем
    _lastLevelIndex = (nextIndex >= 0) ? nextIndex : levelIndex;
    if (chapterJustCompleted) {
      _postcards[chapter.key] = true;
      _bonusHints += 3;
      updateHintBadge();
      updateCheckButton();
    }
    saveProgress();
    trackEvent('puzzle_done', {
      index: levelIndex,
      sec:   Math.round((Date.now() - _levelStartedAt) / 1000),
      hints: _hintsUsedThisLevel,
    });
    if (chapterJustCompleted) trackEvent('chapter_done', { ch: chapter.key });

    scheduleWinReveal(function () {
      revealWin(level, levelIndex, chapter, posInChapter, nextIndex, completedCount, chapterJustCompleted);
      if (unlockedChapter) {
        showRetentionToast(I18N.t('chapterUnlockedToast').replace('{name}', I18N.t(unlockedChapter.nameKey)));
      }
    });
  }

  function revealWin(level, levelIndex, chapter, posInChapter, nextIndex, completedCount, chapterJustCompleted) {
    buildSilhouette(level);
    document.getElementById('win-theme-label').textContent = I18N.t(level.theme);
    if (chapter) {
      document.getElementById('win-chapter-line').hidden = false;
      document.getElementById('win-chapter-line').textContent = I18N.t('winChapterLine')
        .replace('{k}', posInChapter + 1)
        .replace('{name}', I18N.t(chapter.nameKey));
    } else {
      document.getElementById('win-chapter-line').hidden = true;
    }
    hideRetentionToast(); // ТЗ №51а: снять тост «почти собрал» ДО показа оверлея победы
    document.getElementById('win-overlay').hidden = false;
    launchConfetti();
    if (renderWinTomorrow()) trackEvent('teaser_shown');
    updateShareButton(
      level,
      chapter ? I18N.t('storyChapter').replace('{name}', I18N.t(chapter.nameKey)) : '',
      levelIndex
    );

    // ТЗ №49, п.5: крючки площадок — СТРОГО после показа экрана победы, не
    // перед ним. 2-й пройденный уровень кампании -> избранное+ярлык, 5-й ->
    // рекомендовать+отзыв, каждый крючок не больше раза за игрока.
    if (completedCount === 2 && !_hooksShown.fav) {
      _hooksShown.fav = true;
      _hooksShown.shortcut = true;
      saveProgress();
      if (Platform.promptAddToFavorites) Platform.promptAddToFavorites();
      if (Platform.promptShortcut) Platform.promptShortcut();
      trackEvent('favorites_prompt');
    } else if (completedCount === 5 && !_hooksShown.rec) {
      _hooksShown.rec = true;
      _hooksShown.review = true;
      saveProgress();
      if (Platform.promptRecommend) Platform.promptRecommend();
      if (Platform.requestReview) Platform.requestReview();
    }

    function goNext() {
      _currentLevel = -1;
      maybeShowInterstitial(function () {
        if (nextIndex >= 0) {
          showGame(nextIndex);
        } else {
          showChapters();
        }
      });
    }

    document.getElementById('btn-next-level').textContent = I18N.t('next');
    document.getElementById('btn-next-level').onclick = goNext;

    // Награда за главу — оверлей #chapter-done ПОВЕРХ экрана победы,
    // после конфетти (ТЗ №50, п.3). Его собственная кнопка «Дальше» ведёт
    // ТУДА ЖЕ (goNext) — interstitial-гейт (maybeShowInterstitial) не
    // меняется и не вызывается дважды за одну победу.
    if (chapterJustCompleted) {
      var finalLevel = LEVELS[chapter.indices[chapter.indices.length - 1]];
      paintSilhouetteStatic(document.getElementById('chapter-done-canvas'), finalLevel, 180);
      document.getElementById('chapter-done-title').textContent =
        I18N.t('chapterDoneTitle').replace('{name}', I18N.t(chapter.nameKey));
      document.getElementById('chapter-done-reward').textContent = I18N.t('chapterDoneReward');
      document.getElementById('chapter-done-overlay').hidden = false;
      document.getElementById('btn-chapter-done-next').onclick = function () {
        document.getElementById('chapter-done-overlay').hidden = true;
        goNext();
      };
    }
  }

  /* ---- Подсказка за рекламу ---- */

  function onHintClick() {
    window.debugLog('click: #btn-hint (bonusHints=' + _bonusHints + ')');
    if (!_rewardedGateOpen) {
      window.debugLog('click: #btn-hint проигнорирован — предыдущий запрос ещё в полёте');
      return;
    }
    var hint = Nonogram.findHint();
    if (!hint) {
      document.getElementById('btn-hint').disabled = true;
      return;
    }

    // ТЗ №01, п.2.4/«ЧЕГО НЕ ДЕЛАТЬ»: бонусные подсказки за серию входов —
    // отдельный бесплатный баланс, а не свой гейт частоты рекламы. Тратим
    // ПЕРВЫМИ, без обращения к Platform.showRewarded вообще (не «экономим»
    // рекламный показ игрока — просто эта подсказка не рекламная).
    if (_bonusHints > 0) {
      _bonusHints--;
      _hintsUsedThisLevel++;
      updateHintBadge();
      updateCheckButton();
      Nonogram.applyHint(hint);
      saveProgress();
      if (!Nonogram.findHint()) {
        document.getElementById('btn-hint').disabled = true;
      }
      return;
    }

    var pendingHint = null;
    if (_currentLevel >= 0) flushBoardSave(_currentLevel);
    Sound.suspend();
    Nonogram.setPaused(true);
    // Nonogram.setPaused(true) уже блокирует поле — showAdLoadingOverlay()
    // объясняет ПОЧЕМУ (до 40с ожидания, REWARD_AD_TIMEOUT_MS), а не
    // оставляет игрока смотреть на молча замершую доску (баг-репорт
    // основателя 2026-09-06).
    showAdLoadingOverlay();
    lockRewardedGate();
    if (Platform.gameplayStop) Platform.gameplayStop(); // ТЗ №49, п.5: перед rewarded
    Platform.showRewarded(
      function () { pendingHint = hint; },
      function () {
        unlockRewardedGate();
        hideAdLoadingOverlay();
        Nonogram.setPaused(false);
        Sound.resume();
        if (pendingHint) {
          Nonogram.applyHint(pendingHint);
          pendingHint = null;
          _hintsUsedThisLevel++;
          if (!Nonogram.findHint()) {
            document.getElementById('btn-hint').disabled = true;
          }
        }
      }
    );
  }

  /* ---- ТЗ №51: кнопка «Проверить» ---- */

  // Ключ «текущей картинки» для состояний, живущих только в памяти сессии
  // (_freeCheckUsed/_nudgeShownFor/_nearWinShownFor) — кампания адресуется
  // индексом уровня, пазл дня — датой (бесплатная проверка/тосты пазла дня
  // «сгорают» и заводятся заново на следующий день, как и сам пазл).
  function checkStateKey() {
    return (_currentLevel >= 0) ? ('c' + _currentLevel) : ('d' + _todayKey());
  }

  function updateCheckButton() {
    var btn = document.getElementById('btn-check');
    if (!btn) return;
    var key  = checkStateKey();
    var mode = !_freeCheckUsed[key] ? 'free' : (_bonusHints > 0 ? 'hint' : 'ad');
    var captionKey = mode === 'free' ? 'checkFree' : (mode === 'hint' ? 'checkForHint' : 'checkForAd');
    var caption = document.getElementById('check-caption');
    if (caption) {
      caption.textContent = I18N.t(captionKey);
      caption.setAttribute('data-i18n', captionKey);
    }
    // Иконка рекламы — только в режиме «за рекламу» (п.2 ТЗ №51), иначе
    // статичная «✓» (см. index.html #check-icon-mark/#check-ad-icon).
    // ТЗ №51а: #check-ad-icon — <svg>, у SVGElement нет IDL-свойства hidden
    // (оно определено только на HTMLElement) — `adIcon.hidden = …` тихий
    // no-op, атрибут hidden в разметке никогда не менялся, значок оставался
    // виден во всех режимах. toggleAttribute — обычный метод Element,
    // работает одинаково на HTML и SVG; правило #check-ad-icon[hidden] в
    // style.css довершает (без него [hidden] на svg тоже не прячет узел).
    var adIcon = document.getElementById('check-ad-icon');
    var mark   = document.getElementById('check-icon-mark');
    if (adIcon) adIcon.toggleAttribute('hidden', mode !== 'ad');
    if (mark)   mark.toggleAttribute('hidden', mode === 'ad');
  }

  function onCheckClick() {
    window.debugLog('click: #btn-check (bonusHints=' + _bonusHints + ')');
    if (!_rewardedGateOpen) {
      window.debugLog('click: #btn-check проигнорирован — предыдущий запрос ещё в полёте');
      return;
    }

    // 1. Ошибок нет — сказать об этом, ничего не тратить, короткий
    // дабл-клик-предохранитель (2с), симметричный формулировке ТЗ.
    if (!Nonogram.hasErrors()) {
      showRetentionToast(I18N.t('checkNoErrors'));
      trackEvent('check_used', { mode: 'free', fixed: 0 });
      var noErrBtn = document.getElementById('btn-check');
      if (noErrBtn) {
        noErrBtn.disabled = true;
        setTimeout(function () { noErrBtn.disabled = false; }, 2000);
      }
      return;
    }

    var key = checkStateKey();

    // 2. Бесплатная проверка ещё не потрачена на эту картинку.
    if (!_freeCheckUsed[key]) {
      _freeCheckUsed[key] = true;
      var fixedFree = Nonogram.revealErrors();
      showRetentionToast(I18N.t('checkFixed').replace('{n}', fixedFree));
      trackEvent('check_used', { mode: 'free', fixed: fixedFree });
      updateCheckButton();
      return;
    }

    // 3. Бесплатных подсказок в балансе хватает — тратим одну.
    if (_bonusHints > 0) {
      _bonusHints--;
      updateHintBadge();
      var fixedHint = Nonogram.revealErrors();
      showRetentionToast(I18N.t('checkFixed').replace('{n}', fixedHint));
      trackEvent('check_used', { mode: 'hint', fixed: fixedHint });
      saveProgress();
      updateCheckButton();
      return;
    }

    // 4. Иначе — тот же путь, что и подсказка за рекламу (переиспользуем
    // те же обёртки: showAdLoadingOverlay/lockRewardedGate/идемпотентность
    // через onReward->onClose, см. onHintClick выше).
    var pendingCheck = false;
    if (_currentLevel >= 0) flushBoardSave(_currentLevel);
    Sound.suspend();
    Nonogram.setPaused(true);
    showAdLoadingOverlay();
    lockRewardedGate();
    if (Platform.gameplayStop) Platform.gameplayStop();
    Platform.showRewarded(
      function () { pendingCheck = true; },
      function () {
        unlockRewardedGate();
        hideAdLoadingOverlay();
        Nonogram.setPaused(false);
        Sound.resume();
        if (pendingCheck) {
          pendingCheck = false;
          var fixedAd = Nonogram.revealErrors();
          showRetentionToast(I18N.t('checkFixed').replace('{n}', fixedAd));
          trackEvent('check_used', { mode: 'ad', fixed: fixedAd });
          updateCheckButton();
        }
      }
    );
  }

  /* ---- ТЗ №51: мягкие тосты без кнопки ---- */

  // Вызывается из onMove-колбэка Nonogram.render (showGame/showDailyGame) —
  // на КАЖДЫЙ ход, не только на закраску (autoFillCrosses/крестики тоже
  // зовут _onMove, что и нужно: простой считается от любого действия
  // игрока, не только от заливки).
  function onBoardMove() {
    var now = Date.now();
    _lastMoveAt = now;
    if (Nonogram.hasErrors()) {
      if (!_errorSince) _errorSince = now;
    } else {
      _errorSince = 0;
    }

    // «Почти собрал»: remainingCells()===0 — это победа (перекрывает тост,
    // см. ТЗ), remainingCells()<=0 не входит в диапазон ниже, специальной
    // проверки не требуется.
    var key = checkStateKey();
    var remaining = Nonogram.remainingCells();
    if (remaining > 0 && remaining <= 3 && !Nonogram.hasErrors() && !_nearWinShownFor[key]) {
      _nearWinShownFor[key] = true;
      var word = I18N.pluralRu(remaining, [I18N.t('cellWordOne'), I18N.t('cellWordFew'), I18N.t('cellWordMany')]);
      showRetentionToast(I18N.t('nearWin').replace('{n}', remaining).replace('{word}', word));
    }
  }

  function startNudgeTimer() {
    stopNudgeTimer();
    _nudgeTimer = setInterval(function () {
      if (!Nonogram.hasErrors() || !_errorSince) return;
      var key = checkStateKey();
      if (_nudgeShownFor[key]) return;
      var now = Date.now();
      if (now - _errorSince >= NUDGE_ERROR_MS && now - _lastMoveAt >= NUDGE_IDLE_MS) {
        _nudgeShownFor[key] = true;
        showRetentionToast(I18N.t('checkNudge'));
      }
    }, 5000);
  }

  function stopNudgeTimer() {
    if (_nudgeTimer) { clearInterval(_nudgeTimer); _nudgeTimer = null; }
  }

  /* ---- ТЗ №51: шеринг картинки в историю ВК (только ВК-сборка) ---- */

  // Канвас 1080×1920, только canvas + системный шрифт (никаких внешних
  // шрифтов/картинок — требование ТЗ). subtitle — «глава «Имя»» (кампания)
  // либо «Пазл дня, {дата}» (daily), готовая строка от вызывающей стороны.
  function buildStoryImage(level, subtitle) {
    var canvas = document.createElement('canvas');
    canvas.width  = 1080;
    canvas.height = 1920;
    var ctx = canvas.getContext('2d');
    var style = getComputedStyle(document.documentElement);
    var bg  = style.getPropertyValue('--bg').trim()  || '#f3ead6';
    var ink = style.getPropertyValue('--ink').trim() || '#2b2723';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var W = level.width, H = level.height;
    var maxSize = 860; // px — силуэт крупно по центру
    var cell = Math.max(1, Math.floor(maxSize / Math.max(W, H)));
    var gridW = W * cell, gridH = H * cell;
    var gridX = Math.round((canvas.width  - gridW) / 2);
    var gridY = Math.round((canvas.height - gridH) / 2);

    ctx.fillStyle = ink;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (level.solution[r][c]) ctx.fillRect(gridX + c * cell, gridY + r * cell, cell, cell);
      }
    }

    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.font = '600 56px system-ui, sans-serif';
    ctx.fillText(I18N.t(level.theme), canvas.width / 2, gridY - 110);

    ctx.font = '400 38px system-ui, sans-serif';
    ctx.fillText(subtitle, canvas.width / 2, gridY - 50);

    ctx.font = '400 34px system-ui, sans-serif';
    ctx.fillText(I18N.t('gameTitle'), canvas.width / 2, canvas.height - 90);

    return canvas.toDataURL('image/png');
  }

  function shareCurrentLevel(level, subtitle, trackIndex) {
    var img = buildStoryImage(level, subtitle);
    Platform.shareStory(img).then(function (ok) {
      if (ok) showRetentionToast(I18N.t('shareDone'));
    });
    trackEvent('share_story', { index: trackIndex });
  }

  // «15 сентября 2026» — тот же приём, что showCalendar() (I18N.t('month'+m)),
  // без внешних библиотек форматирования дат.
  function storyDailyDateLabel() {
    var now = Platform.now();
    return now.getDate() + ' ' + I18N.t('month' + (now.getMonth() + 1)) + ' ' + now.getFullYear();
  }

  function updateShareButton(level, subtitle, trackIndex) {
    var btn = document.getElementById('btn-share');
    if (!btn) return;
    var can = !!(Platform.canShareStory && Platform.canShareStory());
    btn.hidden = !can;
    if (!can) return;
    btn.onclick = function () { shareCurrentLevel(level, subtitle, trackIndex); };
  }

  /* ---- Силуэт ---- */

  // Задача G: картинка «проявляется» из клеток — juice-момент экрана
  // победы ТЕКУЩЕГО уровня, не путать с финалом кампании (не трогаем).
  var _silhouetteRAF = null;

  function buildSilhouette(level) {
    if (_silhouetteRAF) { cancelAnimationFrame(_silhouetteRAF); _silhouetteRAF = null; }

    var W = level.width, H = level.height;
    // ТЗ №53: на низких окнах (ВК-десктоп iframe ~600px) силуэт 260px не
    // влезает в карточку даже с компактными паддингами — размер клетки
    // теперь считается от высоты окна (620px и выше — как раньше, 260).
    var base = Math.max(120, Math.min(260, window.innerHeight - 420));
    var CELL = Math.min(48, Math.floor(base / Math.max(W, H)));
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

  /* ---- ТЗ №49, §3: тизер завтрашней картинки дня (экран победы) ---- */

  // Статичный маленький силуэт (без анимации «проявления» — она уместна
  // только для КОМАНДА текущего уровня, buildSilhouette выше) — тот же
  // подход отрисовки: закрашенные клетки level.solution заливкой var(--ink)
  // на var(--bg), просто в один проход, без RAF.
  function buildTeaserSilhouette(level) {
    var canvas = document.getElementById('win-tomorrow-canvas');
    if (!canvas) return;
    var W = level.width, H = level.height;
    var CELL = Math.max(1, Math.floor(72 / Math.max(W, H)));
    canvas.width  = W * CELL;
    canvas.height = H * CELL;
    var ctx = canvas.getContext('2d');
    var style = getComputedStyle(document.documentElement);
    var bg  = style.getPropertyValue('--bg').trim()  || '#f3ead6';
    var ink = style.getPropertyValue('--ink').trim() || '#2b2723';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (level.solution[r][c]) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
  }

  // Показывает блок #win-tomorrow на экране победы (кампания и daily —
  // вызывается из onWin/onDailyWin), только если DAILY_LEVELS подключён
  // (ТЗ №49: теперь общий для обеих сборок, но защитный typeof-гард
  // оставлен на случай раздельной сборки без daily_levels.js). Возвращает
  // true, если блок реально показан (для trackEvent('teaser_shown')).
  function renderWinTomorrow() {
    var el = document.getElementById('win-tomorrow');
    if (!el) return false;
    if (typeof DAILY_LEVELS === 'undefined') { el.hidden = true; return false; }

    var tomorrowIdx = _dailyIndex(_tomorrowDate());
    var level = DAILY_LEVELS[tomorrowIdx];
    if (!level) { el.hidden = true; return false; }

    // Если завтрашний пазл дня совпадает с сегодняшним индексом И сегодня
    // уже пройден (цикл пула короче года — невозможно при пуле 30, но
    // защищаемся: не блюрить картинку, которую игрок уже видел решённой).
    var alreadySeen = (tomorrowIdx === _dailyIndex()) && (_dailyDone === _todayKey());

    buildTeaserSilhouette(level);
    document.getElementById('win-tomorrow-canvas').classList.toggle('is-blurred', !alreadySeen);
    el.hidden = false;
    return true;
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
