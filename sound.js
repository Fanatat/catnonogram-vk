/* ============================================================
   Sound — звук на Web Audio (без аудиофайлов, бандл остаётся крошечным).
   SFX: found (слово найдено), wrong (ошибка), win (победа).
   Пауза: suspend/resume для рекламы (п.4.7) и сворачивания (п.1.3).
   Звук создаётся лениво и только после действия пользователя
   (политика автоплея браузеров).
   ============================================================ */

window.Sound = (function () {
  var ctx = null;
  var muted = false;

  function ensure() {
    if (!ctx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = AC ? new AC() : null;
      } catch (e) { ctx = null; }
    }
    return ctx;
  }

  // Вызывать по действию пользователя (нажатие), чтобы разрешить звук.
  function resumeContext() {
    var c = ensure();
    if (c && c.state === 'suspended') c.resume();
  }

  function beep(freq, dur, type, vol) {
    if (muted) return;
    var c = ensure();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    var t = c.currentTime;
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol || 0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function found() { beep(660, 0.12, 'triangle', 0.18); }
  function wrong() { beep(150, 0.18, 'sawtooth', 0.14); }

  // Задача H: восходящее мажорное арпеджио до-ми-соль-до (C5-E5-G5-C6),
  // ОРИГИНАЛЬНАЯ попевка — не цитата известной мелодии, просто гамма
  // трезвучия. ~1.15с целиком, кульминация держится подольше.
  function win() {
    beep(523,  0.22, 'triangle', 0.20); // до
    setTimeout(function () { beep(659,  0.22, 'triangle', 0.20); }, 220); // ми
    setTimeout(function () { beep(784,  0.24, 'triangle', 0.20); }, 440); // соль
    setTimeout(function () { beep(1047, 0.42, 'triangle', 0.22); }, 680); // до (октавой выше)
  }

  // Задача H: «Ряд закрыт» — одна мягкая нота (синус, не резкая).
  function lineClosed() { beep(587, 0.16, 'sine', 0.12); }

  // Задача H: «Клетка» — короткий тик при заливке/крестике/автокрестике.
  function tick() { beep(880, 0.035, 'sine', 0.05); }

  // Пауза/возврат звука (реклама, сворачивание).
  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (!muted && ctx && ctx.state === 'suspended') ctx.resume(); }

  function setMuted(m) { muted = !!m; if (muted) suspend(); else resume(); }
  function isMuted() { return muted; }

  function init() {
    // Звук останавливается при сворачивании страницы (п.1.3).
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) suspend(); else resume();
    });
  }

  return {
    init: init, resumeContext: resumeContext,
    found: found, wrong: wrong, win: win,
    lineClosed: lineClosed, tick: tick,
    suspend: suspend, resume: resume,
    setMuted: setMuted, isMuted: isMuted,
  };
})();
