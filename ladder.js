/* ============================================================
   ladder.js — лестница 7 дней («Завтра в игре», ТЗ №49). Замена наградной
   части старой серии входов retention.js (которая с этого ТЗ только
   СЧИТАЕТ серию через onEnter, но сама больше ничего не выдаёт —
   RETENTION_CONFIG.streakDayReward: {} в main.js).

   Чистые функции без побочных эффектов — тот же принцип, что в retention.js/
   save.js: не трогают DOM, не читают Platform, не лезут в COSMETICS/main.js
   напрямую. Тестируется в Node без браузера (tools/test_ladder_core.js).

   Формула дней (_dayAnchor/dayDiff) буквально скопирована из main.js/
   retention.js — НЕ импортируется (у каждого модуля своя копия, тот же
   приём, что retention.js уже применяет к main.js: см. заголовок
   retention.js про dayKeyFromDate/_dayAnchor).
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Ladder = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {

  // Индекс 0 = день 1. День 7 — «финал», после него лестница идёт по кругу
  // с 4-го дня (advance() ниже) — дни 4-7 повторяются бесконечно.
  var LADDER = [
    { hints: 1 },
    { hints: 2 },
    { style: 'cosmetic_streak_rust', fallbackHints: 2 },
    { hints: 3 },
    // 2026-09-25: дни 5 и 7 давали «дневной запас» (+6 пазлов раздатчику).
    // Главы теперь открываются прогрессом, таймера нет — запас заменён
    // подсказками (решение основателя «только прогресс, без таймера»).
    { hints: 5 },
    { hints: 3 },
    { style: 'cosmetic_night', hints: 3, fallbackHints: 3 },
  ];

  // 'YYYY-M-D' → мс фиксированного (но произвольного) момента этой
  // календарной даты — только для разницы в днях между двумя ключами.
  // Идентична _dayAnchor() в main.js/retention.js.
  function _dayAnchor(key) {
    var p = key.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  function dayDiff(fromKey, toKey) {
    return Math.round((_dayAnchor(toKey) - _dayAnchor(fromKey)) / 86400000);
  }

  // state = { day, lastDay, series, claimedDay }. day: 0..7 (0 = ещё ни разу
  // не открывалась), lastDay/claimedDay: 'YYYY-M-D' или '', series: дней
  // подряд, включая сегодня. Возвращает { state, opened } — opened:true,
  // если ЭТОТ вызов реально продвинул день (первый вход за сегодня);
  // claimedDay НИКОГДА не трогается здесь — только claimLadderReward
  // (main.js) отмечает награду забранной.
  function advance(state, todayKey) {
    if (state.lastDay === todayKey) {
      return { state: state, opened: false };
    }

    var diff = state.lastDay ? dayDiff(state.lastDay, todayKey) : null;
    var day, series;
    // diff === null (самый первый вход), diff > 1 (пропуск дня) и diff < 0
    // (часы устройства переведены назад) — все три считаются как разрыв
    // серии: день 1, серия 1. Диапазон «часы вперёд больше чем на 1 день»
    // уже покрыт diff > 1 — тот же путь, отдельной веткой не выделяем.
    if (diff === null || diff > 1 || diff < 0) {
      day = 1;
      series = 1;
    } else { // diff === 1 — вчера, серия продолжается
      day = (state.day >= 7) ? 4 : state.day + 1;
      series = state.series + 1;
    }

    return {
      state: {
        day: day,
        lastDay: todayKey,
        series: series,
        claimedDay: state.claimedDay,
      },
      opened: true,
    };
  }

  // { hints, style } для дня 1..7. Если день дал бы стиль, которым
  // игрок уже владеет (косметика не отбирается и не дублируется) —
  // подставляется fallbackHints вместо стиля (день не остаётся пустым).
  // День 7 несёт И стиль, И подсказки разом — вызывающий (main.js) обязан
  // уметь показать оба одновременно.
  function rewardFor(day, ownedStyles) {
    var entry = LADDER[day - 1];
    if (!entry) return { hints: 0, style: null };
    var out = { hints: entry.hints || 0, style: null };
    if (entry.style) {
      if (ownedStyles && ownedStyles[entry.style]) {
        out.hints += (entry.fallbackHints || 0);
      } else {
        out.style = entry.style;
      }
    }
    return out;
  }

  function isClaimed(state, todayKey) {
    return state.claimedDay === todayKey;
  }

  return {
    LADDER: LADDER,
    advance: advance,
    rewardFor: rewardFor,
    isClaimed: isClaimed,
    dayDiff: dayDiff,
  };
});
