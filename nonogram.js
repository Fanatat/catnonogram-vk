/* ============================================================
   Nonogram — подсказки, состояние доски, ввод, проверка победы.
   ============================================================ */

window.Nonogram = (function () {

  var _level      = null;
  var _boardState = [];
  var _clues      = null;    // кэш подсказок текущего уровня
  var _mode       = 1;       // 1=закрасить, 2=крестик
  var _isDragging = false;
  var _dragAction = null;    // 'set' | 'clear'
  var _dragValue  = 1;       // значение, которое ставит 'set' в этом штрихе (1 или 2)
  var _lastCell   = null;
  var _onWin      = null;
  var _onMove     = null;    // колбэк main.js для дебаунс-сейва
  var _won        = false;
  var _paused     = false;   // true во время рекламы — блокирует ввод
  var _strokeSnapshot = null; // снимок доски в начале штриха для отмены при pinch

  // ---- Зум / пан ----
  var _scale      = 1;
  var _tx         = 0;       // translate X
  var _ty         = 0;       // translate Y
  var _viewport   = null;    // div-обёртка с transform
  var _container  = null;    // puzzle-container (родитель)

  // Состояние pinch
  var _pinch        = null;   // { dist, cx, cy, tx, ty, scale }
  var _pinchActive  = false;  // true пока активен жест двумя пальцами
  var _dragPointerId = null;  // pointerId пальца, рисующего кисть
  // Состояние пан (средняя кнопка / пробел)
  var _panning    = false;
  var _panStart   = null;
  var _spaceDown  = false;

  /* ----------------------------------------------------------
     calcClues — единственный источник числовых подсказок
  ---------------------------------------------------------- */
  function calcClues(solution) {
    var H = solution.length, W = solution[0].length;
    var rows = [], cols = [];

    for (var r = 0; r < H; r++) {
      var clue = [], run = 0;
      for (var c = 0; c < W; c++) {
        if (solution[r][c]) { run++; }
        else if (run) { clue.push(run); run = 0; }
      }
      if (run) clue.push(run);
      rows.push(clue.length ? clue : [0]);
    }

    for (var cc = 0; cc < W; cc++) {
      var clue2 = [], run2 = 0;
      for (var rr = 0; rr < H; rr++) {
        if (solution[rr][cc]) { run2++; }
        else if (run2) { clue2.push(run2); run2 = 0; }
      }
      if (run2) clue2.push(run2);
      cols.push(clue2.length ? clue2 : [0]);
    }

    return { rows: rows, cols: cols };
  }

  /* ----------------------------------------------------------
     checkWin — строгое равенство закрашенных клеток и решения.
     Крестики (state=2) трактуются как пустые (0).
     Лишняя закраска → false. Недостающая → false.
     Возвращает явный true/false, никаких побочных эффектов.
  ---------------------------------------------------------- */
  function checkWin(boardState, solution) {
    var H = solution.length, W = solution[0].length;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        var filled = (boardState[r][c] === 1) ? 1 : 0; // crosses → 0
        if (filled !== solution[r][c]) return false;
      }
    }
    return true;
  }

  /* ---- Режим ввода ---- */
  function setMode(m) { _mode = m; }

  /* ----------------------------------------------------------
     Зум / пан
  ---------------------------------------------------------- */

  var SCALE_MIN = 1, SCALE_MAX = 4;

  function applyTransform() {
    if (!_viewport) return;
    // Ограничиваем пан: не уходим за края контейнера
    if (_container) {
      var cw = _container.clientWidth;
      var ch = _container.clientHeight;
      var vw = _viewport.scrollWidth;
      var vh = _viewport.scrollHeight;
      var maxTx = Math.max(0, (vw * _scale - cw) / 2);
      var maxTy = Math.max(0, (vh * _scale - ch) / 2);
      _tx = Math.max(-maxTx, Math.min(maxTx, _tx));
      _ty = Math.max(-maxTy, Math.min(maxTy, _ty));
    }
    _viewport.style.transform = 'translate(' + _tx + 'px,' + _ty + 'px) scale(' + _scale + ')';
  }

  function pinchDist(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pinchCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  function onTouchStart(e) {
    if (e.touches.length < 2) return;
    // Два пальца: помечаем pinch РАНЬШЕ, чем сработает pointerdown второго пальца
    _pinchActive = true;
    e.preventDefault();
    if (_isDragging) {
      _isDragging = false; _dragAction = null; _lastCell = null; _dragPointerId = null;
      window.removeEventListener('pointermove',   onPointerMove);
      window.removeEventListener('pointerup',     onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      cancelStroke();
    }
    _pinch = {
      dist:  pinchDist(e.touches),
      cx:    pinchCenter(e.touches).x,
      cy:    pinchCenter(e.touches).y,
      scale: _scale,
      tx:    _tx,
      ty:    _ty,
    };
  }

  function onTouchMove(e) {
    if (!_pinch || e.touches.length < 2) return;
    e.preventDefault();
    var newDist = pinchDist(e.touches);
    var ratio   = newDist / _pinch.dist;
    var newScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, _pinch.scale * ratio));

    var center = pinchCenter(e.touches);
    // Смещение центра жеста — добавляем как пан
    var dPanX = center.x - _pinch.cx;
    var dPanY = center.y - _pinch.cy;

    _scale = newScale;
    _tx    = _pinch.tx + dPanX;
    _ty    = _pinch.ty + dPanY;
    applyTransform();
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) _pinch = null;
    if (e.touches.length === 0) _pinchActive = false;
  }

  // Колесо мыши — зум
  function onWheel(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    _scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, _scale * delta));
    applyTransform();
  }

  // Средняя кнопка мыши — пан
  function onMouseDown(e) {
    if (e.button !== 1 && !_spaceDown) return;
    e.preventDefault();
    _panning  = true;
    _panStart = { x: e.clientX - _tx, y: e.clientY - _ty };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
  }

  function onMouseMove(e) {
    if (!_panning) return;
    _tx = e.clientX - _panStart.x;
    _ty = e.clientY - _panStart.y;
    applyTransform();
  }

  function onMouseUp() {
    _panning = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup',   onMouseUp);
  }

  function onKeyDown(e) {
    if (e.code === 'Space') { e.preventDefault(); _spaceDown = true; }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') _spaceDown = false;
  }

  function resetZoom() {
    _scale = 1; _tx = 0; _ty = 0;
    applyTransform();
  }

  function attachZoomHandlers(container) {
    _container = container;
    // Touch-события нужны с passive:false чтобы разрешить preventDefault
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove',  onTouchMove,  { passive: false });
    container.addEventListener('touchend',   onTouchEnd);
    container.addEventListener('wheel',      onWheel,      { passive: false });
    container.addEventListener('mousedown',  onMouseDown);
    document.addEventListener('keydown',     onKeyDown);
    document.addEventListener('keyup',       onKeyUp);
  }

  function detachZoomHandlers(container) {
    if (!container) return;
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove',  onTouchMove);
    container.removeEventListener('touchend',   onTouchEnd);
    container.removeEventListener('wheel',      onWheel);
    container.removeEventListener('mousedown',  onMouseDown);
    document.removeEventListener('keydown',     onKeyDown);
    document.removeEventListener('keyup',       onKeyUp);
  }

  /* ---- Обновление DOM одной клетки ---- */
  function renderCell(r, c) {
    var el = document.querySelector('.grid-cell[data-r="' + r + '"][data-c="' + c + '"]');
    if (!el) return;
    var s = _boardState[r][c];
    el.classList.toggle('is-filled', s === 1);
    el.classList.toggle('is-cross',  s === 2);
  }

  /* ----------------------------------------------------------
     Ввод: тап и кисть-протяжка
     applyToCell возвращает true, если изменилось состояние
     заливки (0↔1) — только тогда проверяем победу.
     Смена крестика (0↔2) победу не триггерит.
  ---------------------------------------------------------- */
  function cellFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (!el.classList.contains('grid-cell')) {
      el = el.closest ? el.closest('.grid-cell') : null;
    }
    if (!el) return null;
    var r = parseInt(el.dataset.r, 10);
    var c = parseInt(el.dataset.c, 10);
    if (isNaN(r) || isNaN(c)) return null;
    return { r: r, c: c };
  }

  // Возвращает true, если изменение затронуло состояние закраски (1).
  function applyToCell(r, c) {
    var prev = _boardState[r][c];
    if (_dragAction === 'set') {
      if (prev === 0) {
        _boardState[r][c] = _dragValue;
        renderCell(r, c);
        if (_onMove) _onMove();
        return _dragValue === 1;
      }
    } else {
      if (prev !== 0) {
        _boardState[r][c] = 0;
        renderCell(r, c);
        if (_onMove) _onMove();
        return prev === 1;
      }
    }
    return false;
  }

  // Сохраняет снимок доски в начале штриха.
  function beginStroke() {
    _strokeSnapshot = _boardState.map(function (row) { return row.slice(); });
  }

  // Откатывает все изменения штриха (включая авто-крестики) по снимку.
  function cancelStroke() {
    if (!_strokeSnapshot || !_level) return;
    var H = _level.height, W = _level.width;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (_boardState[r][c] !== _strokeSnapshot[r][c]) {
          _boardState[r][c] = _strokeSnapshot[r][c];
          renderCell(r, c);
        }
      }
    }
    _strokeSnapshot = null;
  }

  /* ----------------------------------------------------------
     getValidPlacements(line, clue)
     Перебирает все структурно допустимые расстановки блоков clue
     на линии длины line.length.

     Единственное ограничение из текущего состояния:
       блок НЕ может накрывать крестик (state=2).
     Заполненные клетки (state=1) НЕ влияют на допустимость —
     расстановки перебираются по логике clue + позиции крестиков.

     Возвращает массив bool[]-покрытий (true = клетка накрыта блоком).

     Контрпример-тест: clue=[3], n=5, line=[1,1,1,0,0]
       → 3 расстановки: [0-1-2],[1-2-3],[2-3-4]
       → ни одна клетка не пуста во всех трёх → крестики НЕ ставятся ✓
  ---------------------------------------------------------- */
  function getValidPlacements(line, clue) {
    var n = line.length;
    var blocks = (clue.length === 1 && clue[0] === 0) ? [] : clue;
    var k = blocks.length;
    var results = [];
    var covered = new Array(n).fill(false);

    function recurse(bi, start) {
      if (bi === k) {
        // Все блоки размещены — непокрытых закрашенных клеток быть не должно
        for (var i = start; i < n; i++) {
          if (line[i] === 1) return;
        }
        results.push(covered.slice());
        return;
      }
      var len = blocks[bi];
      var maxPos = n - len;
      for (var j = bi + 1; j < k; j++) maxPos -= (blocks[j] + 1);

      for (var pos = start; pos <= maxPos; pos++) {
        // Блок не должен накрывать крестик
        var fits = true;
        for (var p = pos; p < pos + len; p++) {
          if (line[p] === 2) { fits = false; break; }
        }
        // Клетка сразу после блока не должна быть закрашена:
        // следующий блок начнётся не раньше pos+len+1, и она окажется непокрытой
        var gapOk = (pos + len >= n) || (line[pos + len] !== 1);

        if (fits && gapOk) {
          for (var p2 = pos; p2 < pos + len; p2++) covered[p2] = true;
          recurse(bi + 1, pos + len + 1);
          for (var p3 = pos; p3 < pos + len; p3++) covered[p3] = false;
        }

        // Нельзя перепрыгнуть через закрашенную клетку — она должна быть покрыта блоком
        if (line[pos] === 1) break;
      }
    }

    recurse(0, 0);
    return results;
  }

  /* ----------------------------------------------------------
     autoFillCrosses — ставит крестики только на клетки,
     гарантированно пустые во ВСЕХ допустимых расстановках
     (по логике подсказок, без обращения к _level.solution).
  ---------------------------------------------------------- */
  function autoFillCrosses(r, c) {
    if (!_level || !_clues) return;
    var W = _level.width, H = _level.height;

    function processLine(line, clue, setCell) {
      var placements = getValidPlacements(line, clue);
      if (placements.length === 0) return;
      var changed = false;
      for (var i = 0; i < line.length; i++) {
        if (line[i] !== 0) continue; // только пустые клетки
        var alwaysEmpty = true;
        for (var p = 0; p < placements.length; p++) {
          if (placements[p][i]) { alwaysEmpty = false; break; }
        }
        if (alwaysEmpty) { setCell(i); changed = true; }
      }
      if (changed && _onMove) _onMove();
    }

    processLine(
      _boardState[r].slice(),
      _clues.rows[r],
      function (i) { _boardState[r][i] = 2; renderCell(r, i); }
    );

    var col = [];
    for (var rr = 0; rr < H; rr++) col.push(_boardState[rr][c]);
    processLine(
      col,
      _clues.cols[c],
      function (i) { _boardState[i][c] = 2; renderCell(i, c); }
    );
  }

  function tryWin() {
    if (_won) return;
    if (checkWin(_boardState, _level.solution)) {
      _won = true;
      if (_onWin) _onWin();
    }
  }

  function onPointerDown(e) {
    e.preventDefault();
    if (_won || _paused) return;
    if (_pinchActive || _isDragging) return; // второй палец или pinch — игнорируем
    var cell = cellFromPoint(e.clientX, e.clientY);
    if (!cell) return;

    // ПКМ — десктопный стандарт жанра: всегда крестик (независимо от
    // тумблера режима), протяжка с зажатой ПКМ красит крестики кистью.
    // ЛКМ/тач/перо — как раньше, красят по текущему режиму (_mode).
    _dragValue  = (e.button === 2) ? 2 : _mode;
    _dragPointerId = e.pointerId;
    _dragAction = (_boardState[cell.r][cell.c] === 0) ? 'set' : 'clear';
    _isDragging = true;
    _lastCell   = { r: cell.r, c: cell.c };
    beginStroke();

    var changed = applyToCell(cell.r, cell.c);
    autoFillCrosses(cell.r, cell.c);
    if (changed) tryWin();

    window.addEventListener('pointermove',   onPointerMove);
    window.addEventListener('pointerup',     onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!_isDragging || e.pointerId !== _dragPointerId) return;
    var cell = cellFromPoint(e.clientX, e.clientY);
    if (!cell) return;
    if (_lastCell && _lastCell.r === cell.r && _lastCell.c === cell.c) return;
    _lastCell = { r: cell.r, c: cell.c };
    var changed = applyToCell(cell.r, cell.c);
    autoFillCrosses(cell.r, cell.c);
    if (changed) tryWin();
  }

  function onPointerUp(e) {
    if (e && e.pointerId !== _dragPointerId) return;
    _isDragging      = false;
    _dragAction      = null;
    _lastCell        = null;
    _dragPointerId   = null;
    _strokeSnapshot  = null; // штрих зафиксирован
    window.removeEventListener('pointermove',   onPointerMove);
    window.removeEventListener('pointerup',     onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }

  /* ----------------------------------------------------------
     render(level, container, onWin)
  ---------------------------------------------------------- */
  function render(level, container, onWin, onMove) {
    detachZoomHandlers(_container);
    _level  = level;
    _clues  = calcClues(level.solution);
    _onWin  = onWin  || null;
    _onMove = onMove || null;
    _won    = false;
    _mode   = 1;
    _isDragging = false; _dragAction = null; _dragValue = 1; _lastCell = null;
    _strokeSnapshot = null;
    _scale = 1; _tx = 0; _ty = 0; _pinch = null; _pinchActive = false;
    _dragPointerId = null; _panning = false;

    _boardState = [];
    for (var ri = 0; ri < level.height; ri++) {
      _boardState[ri] = [];
      for (var ci = 0; ci < level.width; ci++) _boardState[ri][ci] = 0;
    }

    var clues = calcClues(level.solution);
    var W = level.width, H = level.height;

    var maxRowLen = clues.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var maxColLen = clues.cols.reduce(function (m, c) { return Math.max(m, c.length); }, 0);

    var NUM_W = 16, NUM_H = 20, PAD = 12, HEAD_H = 52, MODE_H = 64;
    var rowClueW = maxRowLen * NUM_W + 8;
    var colClueH = maxColLen * NUM_H + 6;
    var availW = window.innerWidth  - PAD * 2 - rowClueW;
    var availH = window.innerHeight - PAD * 2 - HEAD_H - MODE_H - colClueH;
    var cell = Math.max(24, Math.min(56, Math.floor(Math.min(availW / W, availH / H))));

    var puzzle = document.createElement('div');
    puzzle.className = 'puzzle';
    puzzle.style.cssText = '--cell:' + cell + 'px;--clue-col-w:' + rowClueW + 'px;';

    var corner = document.createElement('div');
    corner.className = 'puzzle-tl';
    puzzle.appendChild(corner);

    var colArea = document.createElement('div');
    colArea.className = 'puzzle-col-clues';
    for (var c = 0; c < W; c++) {
      var ccDiv = document.createElement('div');
      ccDiv.className = 'col-clue';
      for (var i = 0; i < clues.cols[c].length; i++) {
        var sp = document.createElement('span');
        sp.textContent = clues.cols[c][i];
        ccDiv.appendChild(sp);
      }
      colArea.appendChild(ccDiv);
    }
    puzzle.appendChild(colArea);

    var rowArea = document.createElement('div');
    rowArea.className = 'puzzle-row-clues';
    for (var r = 0; r < H; r++) {
      var rcDiv = document.createElement('div');
      rcDiv.className = 'row-clue';
      for (var j = 0; j < clues.rows[r].length; j++) {
        var sp2 = document.createElement('span');
        sp2.textContent = clues.rows[r][j];
        rcDiv.appendChild(sp2);
      }
      rowArea.appendChild(rcDiv);
    }
    puzzle.appendChild(rowArea);

    var gridEl = document.createElement('div');
    gridEl.className = 'puzzle-grid';
    for (var r2 = 0; r2 < H; r2++) {
      var rowEl = document.createElement('div');
      rowEl.className = 'grid-row';
      for (var c2 = 0; c2 < W; c2++) {
        var cellEl = document.createElement('div');
        cellEl.className = 'grid-cell';
        cellEl.dataset.r = r2;
        cellEl.dataset.c = c2;
        rowEl.appendChild(cellEl);
      }
      gridEl.appendChild(rowEl);
    }
    gridEl.addEventListener('pointerdown', onPointerDown);
    puzzle.appendChild(gridEl);

    // Viewport-обёртка для transform (зум/пан не трогает layout)
    _viewport = document.createElement('div');
    _viewport.style.cssText = 'transform-origin:center center;will-change:transform;display:inline-flex;';
    _viewport.appendChild(puzzle);

    container.innerHTML = '';
    container.appendChild(_viewport);

    attachZoomHandlers(container);
  }

  /* ----------------------------------------------------------
     findHint()
     Ищет одну неверную клетку с приоритетом:
       1. Закрашена, но должна быть пустой (action:'clear') — блокирует победу
       2. Не закрашена, но должна быть закрашенной (action:'fill')
     Возвращает { r, c, action } или null если ошибок нет.
  ---------------------------------------------------------- */
  function findHint() {
    if (!_level || _won) return null;
    var H = _level.height, W = _level.width;
    var sol = _level.solution;

    // Приоритет: лишние закраски (мешают победе)
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (_boardState[r][c] === 1 && sol[r][c] === 0) {
          return { r: r, c: c, action: 'clear' };
        }
      }
    }
    // Недостающие закраски
    for (var r2 = 0; r2 < H; r2++) {
      for (var c2 = 0; c2 < W; c2++) {
        if (_boardState[r2][c2] !== 1 && sol[r2][c2] === 1) {
          return { r: r2, c: c2, action: 'fill' };
        }
      }
    }
    return null;
  }

  /* ----------------------------------------------------------
     applyHint(hint)
     clear → снимает закраску и ставит крестик («точно пусто»)
     fill  → закрашивает и проверяет победу
  ---------------------------------------------------------- */
  function applyHint(hint) {
    if (!hint || _won) return;
    if (hint.action === 'clear') {
      _boardState[hint.r][hint.c] = 2;
      renderCell(hint.r, hint.c);
    } else {
      _boardState[hint.r][hint.c] = 1;
      renderCell(hint.r, hint.c);
    }
    if (_onMove) _onMove();
    autoFillCrosses(hint.r, hint.c);
    if (checkWin(_boardState, _level.solution)) {
      _won = true;
      if (_onWin) _onWin();
    }
  }

  /* ----------------------------------------------------------
     clearBoard() — свободный режим: ошибки не подсвечиваются,
     игрок может запутаться, ему нужен явный сброс без потери
     доступа к уровню. Очищает заливку И крестики, перерисовывает
     клетки. Сохранение — забота вызывающей стороны (main.js).
  ---------------------------------------------------------- */
  function clearBoard() {
    if (!_level) return;
    var H = _level.height, W = _level.width;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (_boardState[r][c] !== 0) {
          _boardState[r][c] = 0;
          renderCell(r, c);
        }
      }
    }
  }

  function setPaused(v) { _paused = !!v; }

  function getBoardState() {
    // Возвращает плоский снимок для сохранения: [[0,1,2,...],...]
    return _boardState.map(function (row) { return row.slice(); });
  }

  // Восстанавливает доску из сохранённого снимка после render().
  function restoreBoard(matrix) {
    if (!matrix || !_level) return;
    var H = _level.height, W = _level.width;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        var v = (matrix[r] && matrix[r][c]) || 0;
        if (v !== 0) {
          _boardState[r][c] = v;
          renderCell(r, c);
        }
      }
    }
  }

  return {
    calcClues:     calcClues,
    checkWin:      checkWin,
    render:        render,
    setMode:       setMode,
    findHint:      findHint,
    applyHint:     applyHint,
    clearBoard:    clearBoard,
    setPaused:     setPaused,
    getBoardState: getBoardState,
    restoreBoard:  restoreBoard,
    resetZoom:     resetZoom,
  };
})();
