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
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Save = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {

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
    };
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
    out.boardStates    = (oldSave.boardStates && typeof oldSave.boardStates === 'object') ? oldSave.boardStates : {};
    out.dailyDone      = (typeof oldSave.dailyDone === 'string') ? oldSave.dailyDone : '';
    out.streak         = (typeof oldSave.streak === 'number') ? oldSave.streak : 0;
    out.dailyDays      = (oldSave.dailyDays && typeof oldSave.dailyDays === 'object') ? oldSave.dailyDays : {};
    out.dailyBoard     = (oldSave.dailyBoard && typeof oldSave.dailyBoard === 'object') ? oldSave.dailyBoard : null;
    out.dailyBoardDate = (typeof oldSave.dailyBoardDate === 'string') ? oldSave.dailyBoardDate : '';

    return out;
  }

  return {
    emptySave: emptySave,
    migrate:   migrate,
  };
});
