/* ============================================================
   chapters_map.js — ТЗ №50. Позиция <-> индекс LEVELS, по порядку глав
   (window.CHAPTERS, см. chapters.js). Позиция — порядковый номер картинки
   в последовательности глав: глава 1 -> 0..9, глава 2 -> 10..19, …,
   глава 13 -> 120..129 (см. CLAUDE.md, «Модуль удержания»).

   Чистые функции (тот же принцип, что save.js/retention.js) — не трогают
   DOM/Platform, строятся один раз из window.CHAPTERS при загрузке файла.
   Требует, чтобы chapters.js был подключен ДО этого файла (и в
   index.html, и в тестах — window.CHAPTERS уже должен существовать).
   ============================================================ */

window.ChaptersMap = (function () {
  var CHAPTERS = window.CHAPTERS;

  var _posToIndex = [];
  var _indexToPos = {};

  CHAPTERS.forEach(function (ch) {
    ch.indices.forEach(function (idx) {
      _indexToPos[idx] = _posToIndex.length;
      _posToIndex.push(idx);
    });
  });

  function posToIndex(pos) {
    return _posToIndex[pos];
  }

  function indexToPos(index) {
    return _indexToPos[index];
  }

  return {
    posToIndex: posToIndex,
    indexToPos: indexToPos,
  };
})();

if (typeof module === 'object') { module.exports = window.ChaptersMap; }
