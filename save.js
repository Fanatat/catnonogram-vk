/* ============================================================
   Save — слой миграции и нормализации сохранённого прогресса.
   Чистые функции без побочных эффектов: не трогают Platform,
   не читают DOM, не пишут данные. Это позволяет тестировать их
   вне браузера (Node) и переиспользовать в других играх студии.

   Формат v1 (до апдейта): плоский { levelIndex } — «следующий
   уровень после последнего выигрыша». Никакой информации о
   категориях, доске, ежедневном режиме или онбординге не было.

   Формат апдейта (текущий): полная структура со всеми полями —
   при каждом сохранении пишется целиком (правило студии), поэтому
   migrate() тоже всегда возвращает полностью заполненный объект.

   Компактная доска (feature/library, фаза 1, п.3): вместо массива
   массивов — { w, h, rle, seq }, где rle — строка серий "значение:
   количество" по строкам слева направо, сверху вниз. seq — момент
   последней записи (Date.now()) для вытеснения самых старых недо-
   решённых досок. migrate() читает и старый (массив массивов), и
   новый формат — на запись всегда уходит компактный.
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Save = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {

  // Единственное место для обеих констант (п.3в) — потолок числа
  // недорешённых досок кампании и байтовый лимит на сериализованный сейв.
  var MAX_UNFINISHED_BOARDS = 3;
  var SAVE_SIZE_GUARD_BYTES = 2000;

  // true, если доска не содержит ни одной значимой отметки (закраски
  // или крестика) — такую доску незачем хранить в сейве.
  function boardIsEmpty(board) {
    if (!board) return true;
    for (var r = 0; r < board.length; r++) {
      var row = board[r];
      for (var c = 0; c < row.length; c++) {
        if (row[c]) return false;
      }
    }
    return true;
  }

  // Массив массивов → { w, h, rle, seq }. seq необязателен (для dailyBoard,
  // где вытеснение не применяется, можно не передавать).
  function encodeBoard(board, seq) {
    var h = board.length;
    var w = h ? board[0].length : 0;
    var runs = [];
    var curVal = null, curCount = 0;
    for (var r = 0; r < h; r++) {
      for (var c = 0; c < w; c++) {
        var v = board[r][c] || 0;
        if (v === curVal) {
          curCount++;
        } else {
          if (curCount > 0) runs.push(curVal + ':' + curCount);
          curVal = v;
          curCount = 1;
        }
      }
    }
    if (curCount > 0) runs.push(curVal + ':' + curCount);
    var encoded = { w: w, h: h, rle: runs.join(',') };
    if (seq != null) encoded.seq = seq;
    return encoded;
  }

  // { w, h, rle } → массив массивов.
  function decodeBoard(encoded) {
    var w = encoded.w, h = encoded.h;
    var flat = [];
    (encoded.rle ? encoded.rle.split(',') : []).forEach(function (tok) {
      if (!tok) return;
      var parts = tok.split(':');
      var val = +parts[0], count = +parts[1];
      for (var i = 0; i < count; i++) flat.push(val);
    });
    var board = [];
    for (var r = 0; r < h; r++) board.push(flat.slice(r * w, (r + 1) * w));
    return board;
  }

  function isEncodedBoard(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x)
      && typeof x.rle === 'string' && typeof x.w === 'number' && typeof x.h === 'number';
  }

  // Принимает ЛЮБОЙ формат доски (старый массив массивов ИЛИ компактный
  // {w,h,rle}) и всегда возвращает массив массивов. null/битые данные → null.
  function decodeBoardAny(x) {
    if (Array.isArray(x)) return x;
    if (isEncodedBoard(x)) return decodeBoard(x);
    return null;
  }

  // Ключ самой старой (по seq) доски в boardStates, либо null, если пусто.
  // Записи без seq (унаследованные от миграции легаси-массивов без метки
  // времени) считаются самыми старыми — сортировка ставит их первыми.
  function oldestBoardKey(boardStates) {
    var keys = Object.keys(boardStates);
    if (!keys.length) return null;
    keys.sort(function (a, b) {
      return (boardStates[a].seq || 0) - (boardStates[b].seq || 0);
    });
    return keys[0];
  }

  // Потолок «последних недорешённых досок» (п.3б) — вытесняет самые
  // старые, пока их не останется maxCount. Мутирует boardStates на месте.
  function capUnfinishedBoards(boardStates, maxCount) {
    while (Object.keys(boardStates).length > maxCount) {
      var oldest = oldestBoardKey(boardStates);
      if (oldest == null) break;
      delete boardStates[oldest];
    }
    return boardStates;
  }

  function emptySave() {
    return {
      completedLevels: {},
      lastLevelIndex:  -1,
      onboardingSeen:  false,
      muted:           false,
      boardStates:     {},
      dailyDone:       '',
      streak:          0,
      dailyDays:       {},
      dailyBoard:      null,   // прогресс ТЕКУЩЕГО дня (доска) — см. dailyBoardDate
      dailyBoardDate:  '',     // 'YYYY-M-D' (локальная дата), которой принадлежит dailyBoard
      cosmeticsOwned:  {},     // { productId: true } — куплено НАВСЕГДА (Задача E)
      activeCosmetic:  '',     // id включённой косметики либо '' (дефолтная тема)
    };
  }

  // Размер сериализованного сейва в байтах (как реально уйдёт в setData).
  function payloadSize(payload) {
    return new Blob([JSON.stringify(payload)]).size;
  }

  // Сторож перед записью: лимит Яндекса на игрока — 200КБ (сверено с
  // документацией SDK, 24.07.2026). Вызывающий передаёт limitBytes с
  // запасом (main.js берёт 150000 — 75% от лимита). Сначала обрезает
  // до MAX_UNFINISHED_BOARDS (п.3б), затем, пока сериализованный payload
  // всё ещё больше limitBytes, выбрасывает САМУЮ СТАРУЮ (по seq)
  // недорешённую доску кампании — НИКОГДА не completedLevels/cosmeticsOwned
  // и прочий прогресс. Останавливается, когда boardStates опустел.
  // Мутирует payload.boardStates.
  function enforceSizeGuard(payload, limitBytes) {
    capUnfinishedBoards(payload.boardStates, MAX_UNFINISHED_BOARDS);
    while (payloadSize(payload) > limitBytes) {
      var oldest = oldestBoardKey(payload.boardStates);
      if (oldest == null) break;
      delete payload.boardStates[oldest];
    }
    return payload;
  }

  // Переводит сейв v1 (плоский levelIndex) либо уже-новый сейв в
  // актуальную структуру апдейта. levelsCount — LEVELS.length на
  // момент миграции (нужно, чтобы не выйти за границы массива уровней).
  function migrate(oldSave, levelsCount) {
    var out = emptySave();
    if (!oldSave) return out;

    if (oldSave.completedLevels && typeof oldSave.completedLevels === 'object') {
      // Уже новый формат — нормализуем поля, защищаясь от битых значений.
      out.completedLevels = oldSave.completedLevels;
      out.lastLevelIndex  = (typeof oldSave.lastLevelIndex === 'number') ? oldSave.lastLevelIndex : -1;
    } else if (typeof oldSave.levelIndex === 'number' && oldSave.levelIndex > 0) {
      // v1: levelIndex = «следующий после последнего выигрыша».
      // Пройдены все уровни [0 .. oldIdx-1]; «Продолжить» ведёт на oldIdx,
      // либо на последний уровень, если игрок прошёл всё.
      var oldIdx = Math.min(oldSave.levelIndex, levelsCount);
      for (var i = 0; i < oldIdx; i++) out.completedLevels[i] = true;
      out.lastLevelIndex = Math.min(oldIdx, levelsCount - 1);
    }
    // Свежий v1-сейв (levelIndex === 0 либо отсутствует) — прогресса нет,
    // out остаётся дефолтным (completedLevels: {}, lastLevelIndex: -1).

    out.onboardingSeen = !!oldSave.onboardingSeen;
    out.muted          = !!oldSave.muted;
    var rawBoardStates = (oldSave.boardStates && typeof oldSave.boardStates === 'object') ? oldSave.boardStates : {};
    out.dailyDone      = (typeof oldSave.dailyDone === 'string') ? oldSave.dailyDone : '';
    out.streak         = (typeof oldSave.streak === 'number') ? oldSave.streak : 0;
    out.dailyDays      = (oldSave.dailyDays && typeof oldSave.dailyDays === 'object') ? oldSave.dailyDays : {};
    var rawDailyBoard  = (oldSave.dailyBoard && typeof oldSave.dailyBoard === 'object') ? oldSave.dailyBoard : null;
    out.dailyBoardDate = (typeof oldSave.dailyBoardDate === 'string') ? oldSave.dailyBoardDate : '';
    out.cosmeticsOwned = (oldSave.cosmeticsOwned && typeof oldSave.cosmeticsOwned === 'object') ? oldSave.cosmeticsOwned : {};
    out.activeCosmetic = (typeof oldSave.activeCosmetic === 'string') ? oldSave.activeCosmetic : '';

    // Подчистка «призрачных» пустых досок — старые сейвы могли записать
    // недорешённую доску, которую потом стёрли до нуля (см. фикс в main.js:
    // flushBoardSave/flushDailySave больше не пишут пустые матрицы, но
    // уже сохранённые ранее нужно один раз тихо убрать при загрузке) —
    // и заодно переводит и старый (массив массивов), и новый (компактный)
    // формат досок в единый компактный вид, без отдельной версии формата.
    var cleanedBoardStates = {};
    var legacySeq = 0; // унаследованные записи без seq получают возрастающий условный порядок
    Object.keys(rawBoardStates).forEach(function (k) {
      var decoded = decodeBoardAny(rawBoardStates[k]);
      if (!decoded || boardIsEmpty(decoded)) return;
      var existingSeq = (rawBoardStates[k] && typeof rawBoardStates[k].seq === 'number') ? rawBoardStates[k].seq : (legacySeq++);
      cleanedBoardStates[k] = encodeBoard(decoded, existingSeq);
    });
    out.boardStates = capUnfinishedBoards(cleanedBoardStates, MAX_UNFINISHED_BOARDS);

    var decodedDaily = decodeBoardAny(rawDailyBoard);
    if (!decodedDaily || boardIsEmpty(decodedDaily)) {
      out.dailyBoard     = null;
      out.dailyBoardDate = '';
    } else {
      out.dailyBoard = encodeBoard(decodedDaily);
    }

    return out;
  }

  return {
    emptySave:             emptySave,
    migrate:               migrate,
    encodeBoard:           encodeBoard,
    decodeBoard:           decodeBoard,
    decodeBoardAny:        decodeBoardAny,
    isEncodedBoard:        isEncodedBoard,
    boardIsEmpty:          boardIsEmpty,
    oldestBoardKey:        oldestBoardKey,
    capUnfinishedBoards:   capUnfinishedBoards,
    payloadSize:           payloadSize,
    enforceSizeGuard:      enforceSizeGuard,
    MAX_UNFINISHED_BOARDS: MAX_UNFINISHED_BOARDS,
    SAVE_SIZE_GUARD_BYTES: SAVE_SIZE_GUARD_BYTES,
  };
});
