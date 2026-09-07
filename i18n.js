/* ============================================================
   Локализация. Базовый язык — RU.
   Текущий язык определяется через Platform.getLang() в main.js.
   ============================================================ */

window.I18N = (function () {
  var STRINGS = {
    ru: {
      loading:   'Загрузка…',
      adLoading: 'Загрузка рекламы…',
      gameTitle: 'Кот и японские кроссворды',
      gameSub:   'японский кроссворд',
      play:      'Играть',
      modeFill:  '■ Закрасить',
      modeCross: '✕ Крестик',
      next:      'Дальше',
      continue:  'Продолжить',
      hint:         'Подсказка',
      hintAdCaption:'за рекламу',
      clearBoard:      'Очистить',
      clearConfirmText:'Очистить поле? Прогресс на этом уровне будет потерян',
      clearYes:        'Да',
      clearCancel:     'Отмена',
      howToTitle: 'Как читать числа',
      howToLine1: 'Числа — длины закрашенных серий слева направо и сверху вниз.',
      howToLine2: 'Между сериями — хотя бы одна пустая клетка.',
      howToOk:   'Понятно!',
      levelHint:   'Проведи по клеткам, чтобы закрасить',
      chooseLevel: 'Выберите сложность',
      levelsAvailable: 'Новые пазлы регулярно',
      catProgressDone:  'Пройдено: {n}',
      catProgressNone:  'Ещё не начато',
      catProgressAllDone: '✓ Пройдено',
      catTutorial: 'Обучение',
      catEasy:     'Лёгкие',
      catMedium:   'Средние',
      catHard:     'Сложные',
      catLibrary:  'Ещё пазлы',
      howTo:       'Как играть',
      daily:       'Ежедневный',
      dailyLabel:  'Ежедневный пазл',
      backToMenu:  'В меню',
      // ТЗ №26, Р5 (25.08): развод формулировок «серии» — на Яндексе
      // строка раздатчика (retentionStreakLine, ниже) встаёт над этой,
      // слово «серия» не должно звучать дважды. Текст — буквально из
      // решения основателя, не переизобретён.
      streakLabel: 'Пазлов подряд: {n}',
      shop:               'Магазин',
      shopTitle:          'Косметика',
      cosmeticDefaultName: 'Тёплая бумага',
      cosmeticInkBlueName: 'Чернильно-синий',
      cosmeticSepiaName:   'Сепия',
      cosmeticGraphiteName:'Графит',
      shopPreview:        'Примерить',
      shopLocked:         'Откроется после {need} пройденных уровней (пройдено {done})',
      shopUnavailable:    'Скоро в продаже',
      shopLoading:        'Загрузка…',
      shopOwned:          'Куплено',
      shopApply:          'Включить',
      shopRemove:         'Выключить',
      shopBuy:            'Купить',
      shopDefault:        'Бесплатно',
      // ТЗ №01: модуль удержания
      shopStreakReward:   'Награда за серию',
      shopStreakLocked:   'Откроется за серию входов',
      cosmeticStreakRustName: 'Терракота',
      // ТЗ №09, фаза 4: дистанция («сколько?»), не имя предыдущей категории
      // (ТЗ №08) — отвечает на конкретный вопрос игрока, не знаменатель
      // (общих чисел кампании по-прежнему нигде нет).
      // ТЗ №12, фаза 3 (4-я итерация): «Ещё N — и откроется» читалось как
      // «пройди ещё N» (доклад основателя), а механика — «откроется само
      // по таймеру/ролику». Новая строка называет ОБА пути явно: играть
      // дальше (ничего не делать) или ускорить роликом — без числа общего
      // объёма кампании (запрет ТЗ №01 остаётся в силе).
      // ТЗ №13, фаза 1: основатель выбрал вариант B из трёх, показанных в
      // ТЗ №12 (docs/reports/2026-08-22_rewarded_cap.md) — вариант A снят.
      catLockedDistance: '{n} {word} до открытия — играйте дальше или откройте роликом',
      retentionWaitingLine: 'Пазлы ждут: {n}',
      retentionNextAt:    'ещё +{n} в {time}',
      // ТЗ №21/22: подпись предела такта раздатчика — показывается ТОЛЬКО
      // когда backlog реально на потолке (main.js renderRetentionDripLine).
      // Из трёх вариантов, отснятых кадрами на приёмку (docs/reports/
      // 2026-08-22_max_label.md), основатель выбрал вариант B (ТЗ №22):
      // «(макс.)» отмечен в Фазе 0 ТЗ №21 как формально неточный (rewarded
      // не ограничен потолком и может увеличить это же число прямо в этом
      // состоянии); «на паузе» — ближе к правде, не обещает неподвижность.
      retentionAtCapSuffix: ' · накопление на паузе',
      retentionEmptyLine: '+{n} {word} {verb} в {time}',
      retentionFull:      'Пазлы ждут — играйте!',
      // ТЗ (RV-маркер, Яндекс 4.5.1, замечание модерации 2026-09-06): подпись
      // должна прямо сказать «реклама», иначе кнопка не проходит п.4.5.1 —
      // на неё нет замены смыслом «плати временем/действием», только рекламой.
      retentionRewardedBtn: 'Смотреть рекламу: +{n} пазлов 🎁',
      puzzleWordOne:      'пазл',
      puzzleWordFew:      'пазла',
      puzzleWordMany:     'пазлов',
      puzzleArriveVerbOne: 'появится',
      puzzleArriveVerbMany: 'появятся',
      // ТЗ №26, Р5 (25.08): встаёт над .daily-meta на Яндексе (streakLabel,
      // выше) — без слова «серия» и без числового склонения. Текст
      // буквально из решения основателя.
      retentionStreakLine:'Вход подряд: {n}',
      retentionRewardHints:'+{n} подсказки бесплатно — серия входов!',
      retentionRewardStyle:'Новый стиль открыт — серия входов!',
      retentionRewardDrip: 'Открыт новый пазл!',
      cross:    'Крест',
      diamond:  'Ромб',
      heart:    'Сердце',
      house:    'Дом',
      flag:     'Флаг',
      star:     'Звезда',
      mushroom: 'Гриб',
      fish:     'Рыба',
      lock:     'Замок',
      cat:      'Кот',
      drop:     'Капля',
      tree:     'Ёлка',
      bell:     'Колокол',
      cup:      'Кубок',
      arrow:    'Стрелка',
      crown:    'Корона',
      ship:     'Корабль',
      arrow10:  'Стрелка',
      tree10:   'Ёлка',
      house10:  'Дом',
      arrow12:  'Стрелка',
      tree12:   'Ёлка',
      rocket:   'Ракета',
      crown12:  'Корона',
      rocket15: 'Ракета',
      boat:     'Лодка',
      crown15:  'Корона',
      shield:   'Щит',
      pentagon: 'Пятиугольник',
      flask:    'Колба',
      hourglass:'Песочные часы',
      // Долив кампании п.2.9 (13×13/14×14/15×15) — tools/gen_campaign_extra.py
      lighthouse: 'Маяк', fortress: 'Крепость', sun: 'Солнце', teddy_bear: 'Мишка',
      galleon: 'Галеон', windmill: 'Мельница', zeppelin: 'Дирижабль', squirrel: 'Белка',
      swan: 'Лебедь', peacock: 'Павлин', carousel: 'Карусель',
      // Рисованный daily-пул (апдейт) — темы животных/предметов/растений/еды/
      // транспорта/одежды/инструментов/дома/природы/музыки/спорта.
      rabbit: 'Заяц', turtle: 'Черепаха', owl: 'Сова', whale: 'Кит',
      elephant: 'Слон', frog: 'Лягушка', deer: 'Олень', penguin: 'Пингвин',
      giraffe: 'Жираф',
      key: 'Ключ', umbrella: 'Зонт', candle: 'Свеча', lamp: 'Лампа',
      glasses: 'Очки', bag: 'Сумка', envelope: 'Конверт', hat: 'Шляпа',
      mirror: 'Зеркало', backpack: 'Рюкзак', wallet: 'Кошелёк', flashlight: 'Фонарик',
      flower: 'Цветок', tulip: 'Тюльпан', palm_tree: 'Пальма', sunflower: 'Подсолнух',
      clover: 'Клевер', oak_tree: 'Дуб', orchid: 'Орхидея', pinecone: 'Шишка',
      acorn: 'Жёлудь', bush: 'Куст', wheat: 'Колосок', fern: 'Папоротник',
      apple: 'Яблоко', banana: 'Банан', ice_cream: 'Мороженое', donut: 'Пончик',
      egg: 'Яйцо', hotdog: 'Хот-дог', popcorn: 'Попкорн', ice_pop: 'Эскимо',
      croissant: 'Круассан', sandwich: 'Сэндвич', candy_cane: 'Леденец-трость',
      train: 'Паровозик', hot_air_balloon: 'Воздушный шар', submarine: 'Подлодка',
      cart: 'Тележка', tricycle: 'Трёхколёсный велосипед', jet_ski: 'Гидроцикл',
      tram: 'Трамвай', sled: 'Санки', snowmobile: 'Снегоход', gondola: 'Гондола',
      t_shirt: 'Футболка', pants: 'Штаны', sock: 'Носок', shoe: 'Ботинок',
      mitten: 'Варежка', scarf: 'Шарф', boot: 'Сапог', belt: 'Ремень', beanie: 'Шапка-бини',
      wrench: 'Гаечный ключ', screwdriver: 'Отвёртка', paintbrush: 'Кисть',
      axe: 'Топор', shovel: 'Лопата', ruler: 'Линейка', pliers: 'Плоскогубцы',
      ladder: 'Лестница', paint_roller: 'Малярный валик',
      chair: 'Стул', table: 'Стол', mug: 'Кружка', fork: 'Вилка', vase: 'Ваза',
      door: 'Дверь', broom: 'Метла', sofa: 'Диван', window: 'Окно', bed: 'Кровать',
      picture_frame: 'Фоторамка',
      cloud: 'Облако', raindrop: 'Капля', mountain: 'Гора', wave: 'Волна',
      icicle: 'Сосулька', tornado: 'Смерч', snowman: 'Снеговик', volcano: 'Вулкан',
      eclipse: 'Затмение', geyser: 'Гейзер',
      musical_note: 'Нота', guitar: 'Гитара', drum: 'Барабан', piano_keys: 'Клавиши',
      xylophone: 'Ксилофон', cymbal: 'Тарелка', banjo: 'Банджо',
      harmonica: 'Губная гармошка', trombone: 'Тромбон', tuba: 'Туба',
      dumbbell: 'Гантеля', goal_post: 'Ворота', hockey_stick: 'Клюшка',
      volleyball: 'Волейбольный мяч', baseball_glove: 'Бейсбольная перчатка',
      football: 'Регби-мяч', ping_pong_paddle: 'Ракетка для настольного тенниса',
      boxing_glove: 'Боксёрская перчатка', bowling_pin: 'Кегля',
      hockey_puck: 'Шайба', surfboard: 'Сёрфборд', javelin: 'Копьё',
      month1:  'Январь',   month2:  'Февраль',  month3:  'Март',
      month4:  'Апрель',   month5:  'Май',       month6:  'Июнь',
      month7:  'Июль',     month8:  'Август',    month9:  'Сентябрь',
      month10: 'Октябрь',  month11: 'Ноябрь',   month12: 'Декабрь',
      wdMon: 'Пн', wdTue: 'Вт', wdWed: 'Ср', wdThu: 'Чт',
      wdFri: 'Пт', wdSat: 'Сб', wdSun: 'Вс',
    },
    en: {
      loading:   'Loading…',
      adLoading: 'Loading ad…',
      gameTitle: 'Picture Cross',
      gameSub:   'japanese crossword',
      play:      'Play',
      modeFill:  '■ Fill',
      modeCross: '✕ Cross',
      next:      'Next',
      continue:  'Continue',
      hint:         'Hint',
      hintAdCaption:'via ad',
      clearBoard:      'Clear',
      clearConfirmText:'Clear the board? Your progress on this level will be lost',
      clearYes:        'Yes',
      clearCancel:     'Cancel',
      howToTitle: 'How to read the numbers',
      howToLine1: 'Numbers show the lengths of filled blocks, in order.',
      howToLine2: 'At least one empty cell separates each block.',
      howToOk:   'Got it!',
      levelHint:   'Drag across cells to fill them',
      chooseLevel: 'Choose difficulty',
      levelsAvailable: 'New puzzles regularly',
      catProgressDone:  'Completed: {n}',
      catProgressNone:  'Not started yet',
      catProgressAllDone: '✓ Completed',
      catTutorial: 'Tutorial',
      catEasy:     'Easy',
      catMedium:   'Medium',
      catHard:     'Hard',
      catLibrary:  'More puzzles',
      howTo:       'How to play',
      daily:       'Daily',
      dailyLabel:  'Daily Puzzle',
      backToMenu:  'Menu',
      streakLabel: 'Puzzles in a row: {n}',
      shop:               'Shop',
      shopTitle:          'Cosmetics',
      cosmeticDefaultName: 'Warm Paper',
      cosmeticInkBlueName: 'Ink Blue',
      cosmeticSepiaName:   'Sepia',
      cosmeticGraphiteName:'Graphite',
      shopPreview:        'Try it on',
      shopLocked:         'Unlocks after {need} completed levels ({done} done)',
      shopUnavailable:    'Coming soon',
      shopLoading:        'Loading…',
      shopOwned:          'Owned',
      shopApply:          'Enable',
      shopRemove:         'Disable',
      shopBuy:            'Buy',
      shopDefault:        'Free',
      // ТЗ №01: retention module
      shopStreakReward:   'Streak reward',
      shopStreakLocked:   'Unlocks via login streak',
      cosmeticStreakRustName: 'Terracotta',
      // ТЗ №13, фаза 1: EN-эквивалент варианта B (RU текст — прямая
      // формулировка основателя; EN переведён по смыслу и структуре, не
      // дословно — «до открытия» = «until unlock», «роликом» = «with a
      // video», сохранён порядок «сначала число, потом оба пути»).
      catLockedDistance: '{n} {word} until unlock — keep playing, or unlock it with a video',
      retentionWaitingLine: 'Puzzles waiting: {n}',
      retentionNextAt:    'plus {n} more at {time}',
      // ТЗ №22: EN-эквивалент варианта B (см. комментарий у RU-ключа) —
      // передан смысл «прирост по таймеру приостановлен», не дословно.
      retentionAtCapSuffix: ' · accumulation paused',
      retentionEmptyLine: '+{n} {word} {verb} at {time}',
      retentionFull:      'Puzzles are waiting — go play!',
      retentionRewardedBtn: 'Watch ad: +{n} puzzles 🎁',
      puzzleWordOne:      'puzzle',
      puzzleWordFew:      'puzzles',
      puzzleWordMany:     'puzzles',
      puzzleArriveVerbOne: 'arrives',
      puzzleArriveVerbMany: 'arrive',
      retentionStreakLine:'Login streak: {n}',
      retentionRewardHints:'+{n} free hints — login streak!',
      retentionRewardStyle:'New style unlocked — login streak!',
      retentionRewardDrip: 'A new puzzle unlocked!',
      cross:    'Cross',
      diamond:  'Diamond',
      heart:    'Heart',
      house:    'House',
      flag:     'Flag',
      star:     'Star',
      mushroom: 'Mushroom',
      fish:     'Fish',
      lock:     'Lock',
      cat:      'Cat',
      drop:     'Drop',
      tree:     'Tree',
      bell:     'Bell',
      cup:      'Trophy',
      arrow:    'Arrow',
      crown:    'Crown',
      ship:     'Ship',
      arrow10:  'Arrow',
      tree10:   'Tree',
      house10:  'House',
      arrow12:  'Arrow',
      tree12:   'Tree',
      rocket:   'Rocket',
      crown12:  'Crown',
      rocket15: 'Rocket',
      boat:     'Boat',
      crown15:  'Crown',
      shield:   'Shield',
      pentagon: 'Pentagon',
      flask:    'Flask',
      hourglass:'Hourglass',
      // Campaign top-up п.2.9 (13×13/14×14/15×15) — tools/gen_campaign_extra.py
      lighthouse: 'Lighthouse', fortress: 'Fortress', sun: 'Sun', teddy_bear: 'Teddy Bear',
      galleon: 'Galleon', windmill: 'Windmill', zeppelin: 'Zeppelin', squirrel: 'Squirrel',
      swan: 'Swan', peacock: 'Peacock', carousel: 'Carousel',
      // Hand-drawn daily pool (update) — animals/objects/plants/food/
      // transport/clothing/tools/home/nature/music/sport themes.
      rabbit: 'Rabbit', turtle: 'Turtle', owl: 'Owl', whale: 'Whale',
      elephant: 'Elephant', frog: 'Frog', deer: 'Deer', penguin: 'Penguin',
      giraffe: 'Giraffe',
      key: 'Key', umbrella: 'Umbrella', candle: 'Candle', lamp: 'Lamp',
      glasses: 'Glasses', bag: 'Bag', envelope: 'Envelope', hat: 'Hat',
      mirror: 'Mirror', backpack: 'Backpack', wallet: 'Wallet', flashlight: 'Flashlight',
      flower: 'Flower', tulip: 'Tulip', palm_tree: 'Palm Tree', sunflower: 'Sunflower',
      clover: 'Clover', oak_tree: 'Oak Tree', orchid: 'Orchid', pinecone: 'Pinecone',
      acorn: 'Acorn', bush: 'Bush', wheat: 'Wheat', fern: 'Fern',
      apple: 'Apple', banana: 'Banana', ice_cream: 'Ice Cream', donut: 'Donut',
      egg: 'Egg', hotdog: 'Hot Dog', popcorn: 'Popcorn', ice_pop: 'Ice Pop',
      croissant: 'Croissant', sandwich: 'Sandwich', candy_cane: 'Candy Cane',
      train: 'Train', hot_air_balloon: 'Hot Air Balloon', submarine: 'Submarine',
      cart: 'Cart', tricycle: 'Tricycle', jet_ski: 'Jet Ski',
      tram: 'Tram', sled: 'Sled', snowmobile: 'Snowmobile', gondola: 'Gondola',
      t_shirt: 'T-Shirt', pants: 'Pants', sock: 'Sock', shoe: 'Shoe',
      mitten: 'Mitten', scarf: 'Scarf', boot: 'Boot', belt: 'Belt', beanie: 'Beanie',
      wrench: 'Wrench', screwdriver: 'Screwdriver', paintbrush: 'Paintbrush',
      axe: 'Axe', shovel: 'Shovel', ruler: 'Ruler', pliers: 'Pliers',
      ladder: 'Ladder', paint_roller: 'Paint Roller',
      chair: 'Chair', table: 'Table', mug: 'Mug', fork: 'Fork', vase: 'Vase',
      door: 'Door', broom: 'Broom', sofa: 'Sofa', window: 'Window', bed: 'Bed',
      picture_frame: 'Picture Frame',
      cloud: 'Cloud', raindrop: 'Raindrop', mountain: 'Mountain', wave: 'Wave',
      icicle: 'Icicle', tornado: 'Tornado', snowman: 'Snowman', volcano: 'Volcano',
      eclipse: 'Eclipse', geyser: 'Geyser',
      musical_note: 'Musical Note', guitar: 'Guitar', drum: 'Drum', piano_keys: 'Piano Keys',
      xylophone: 'Xylophone', cymbal: 'Cymbal', banjo: 'Banjo',
      harmonica: 'Harmonica', trombone: 'Trombone', tuba: 'Tuba',
      dumbbell: 'Dumbbell', goal_post: 'Goal Post', hockey_stick: 'Hockey Stick',
      volleyball: 'Volleyball', baseball_glove: 'Baseball Glove',
      football: 'Football', ping_pong_paddle: 'Ping Pong Paddle',
      boxing_glove: 'Boxing Glove', bowling_pin: 'Bowling Pin',
      hockey_puck: 'Hockey Puck', surfboard: 'Surfboard', javelin: 'Javelin',
      month1:  'January',   month2:  'February',  month3:  'March',
      month4:  'April',     month5:  'May',        month6:  'June',
      month7:  'July',      month8:  'August',     month9:  'September',
      month10: 'October',   month11: 'November',   month12: 'December',
      wdMon: 'Mo', wdTue: 'Tu', wdWed: 'We', wdThu: 'Th',
      wdFri: 'Fr', wdSat: 'Sa', wdSun: 'Su',
    },
  };

  // Языки, для которых показываем русский интерфейс (по рекомендации Яндекса, п.2.10).
  var RU_LOCALES = ['ru', 'be', 'kk', 'uk', 'uz'];

  var current = 'ru';

  function pick(lang) {
    current = 'ru'; // ВК-сборка: RU-only, без автоопределения языка (build.py)
    return current;
  }

  function t(key) {
    var dict = STRINGS[current] || STRINGS.ru;
    return dict[key] != null ? dict[key] : key;
  }

  // ТЗ №08: порция раздатчика (константа конфига, не «сколько ждёт» — то
  // остаётся без склонения, см. main.js) озвучивается честным числом и
  // должна согласовываться по-русски (1 пазл / 2-4 пазла / 5+ пазлов).
  // forms = [one, few, many] — уже переведённые слова (I18N.t(...) вызывает
  // сторона).
  function pluralRu(n, forms) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
    return forms[2];
  }

  // Проставляет переводы во все элементы с атрибутом data-i18n.
  function apply(root) {
    var nodes = (root || document).querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    document.documentElement.lang = current;
  }

  return { pick: pick, t: t, apply: apply, pluralRu: pluralRu, get current() { return current; } };
})();
