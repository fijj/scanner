/* global Vue */
(function () {
  'use strict';

  const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue;

  const STORAGE_KEY = 'scanner.collected.v1';

  const CATALOG = [
    { sku: 'DA103SHS', barcode: '2000000277523' },
    { sku: 'DA102SHS', barcode: '2000000277417' }
  ];

  /* ------------------------------------------------------------------ */
  /*  Журнал событий                                                     */
  /* ------------------------------------------------------------------ */

  function useLog(limit = 60) {
    const entries = ref([]);
    let seq = 0;

    const timestamp = () => {
      const d = new Date();
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    };

    function push(message) {
      entries.value.unshift({ id: ++seq, time: timestamp(), message });
      if (entries.value.length > limit) entries.value.pop();
    }

    function clear() {
      entries.value = [];
    }

    return { entries, push, clear };
  }

  /* ------------------------------------------------------------------ */
  /*  Звук и вибрация                                                    */
  /* ------------------------------------------------------------------ */

  function useSignals(log) {
    let ctx = null;
    let curve = null;

    function context() {
      try {
        if (!ctx) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) {
            log('Web Audio не поддерживается');
            return null;
          }
          ctx = new Ctor();
        }
        // После сна устройства и до первого жеста контекст лежит в suspended
        if (ctx.state === 'suspended') ctx.resume();
      } catch (e) {
        log('аудио недоступно: ' + e.message);
        return null;
      }
      return ctx;
    }

    /* Android разрешает звук только после первого касания экрана */
    function unlock() {
      const audio = context();
      if (!audio) return;
      try {
        const silent = audio.createBufferSource();
        silent.buffer = audio.createBuffer(1, 1, 22050);
        silent.connect(audio.destination);
        silent.start(0);
      } catch (e) { /* контекст уже разблокирован */ }
    }

    function tone(freq, duration, type, gain = 0.4) {
      const audio = context();
      if (!audio) return;
      const at = audio.currentTime + 0.01;
      const osc = audio.createOscillator();
      const amp = audio.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, at);
      amp.gain.setValueAtTime(0.0001, at);
      amp.gain.exponentialRampToValueAtTime(gain, at + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

      osc.connect(amp).connect(audio.destination);
      osc.start(at);
      osc.stop(at + duration + 0.02);
    }

    function distortion(audio) {
      if (!curve) {
        const size = 1024;
        const k = 60;
        curve = new Float32Array(size);
        for (let i = 0; i < size; i++) {
          const x = (i * 2) / size - 1;
          curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
        }
      }
      const shaper = audio.createWaveShaper();
      shaper.curve = curve;
      shaper.oversample = '2x';
      return shaper;
    }

    /* Резкий рваный зуммер: расстроенные пилы через перегруз.
       185/196 Гц дают биения, 262 Гц добавляет диссонанс — намеренно неприятно. */
    function buzz(bursts) {
      const audio = context();
      if (!audio) return;

      const at = audio.currentTime + 0.01;
      const span = bursts * 0.21;
      const amp = audio.createGain();
      amp.gain.value = 0.0001;
      amp.connect(distortion(audio)).connect(audio.destination);

      for (const freq of [185, 196, 262]) {
        const osc = audio.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, at);
        osc.frequency.linearRampToValueAtTime(freq * 0.82, at + span);
        osc.connect(amp);
        osc.start(at);
        osc.stop(at + span + 0.03);
      }

      for (let i = 0; i < bursts; i++) {
        const start = at + i * 0.21;
        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.exponentialRampToValueAtTime(0.5, start + 0.008);
        amp.gain.setValueAtTime(0.5, start + 0.14);
        amp.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
      }
    }

    function vibrate(pattern) {
      try {
        if (navigator.vibrate) navigator.vibrate(pattern);
      } catch (e) { /* вибромотор недоступен */ }
    }

    function success() {
      tone(1200, 0.1, 'square');
      vibrate(60);
    }

    /* bursts: 2 — неизвестный код, 3 — перебор (дольше и заметнее) */
    function error(bursts = 3) {
      buzz(bursts);
      vibrate(bursts >= 3 ? [130, 60, 130, 60, 240] : [110, 70, 110]);
    }

    onMounted(() => {
      document.addEventListener('touchstart', unlock, { capture: true, once: true });
      document.addEventListener('click', unlock, { capture: true, once: true });
      document.addEventListener('visibilitychange', context);
    });

    onBeforeUnmount(() => {
      document.removeEventListener('visibilitychange', context);
    });

    return { success, error };
  }

  /* ------------------------------------------------------------------ */
  /*  Приём штрихкодов со сканера в режиме эмуляции клавиатуры           */
  /* ------------------------------------------------------------------ */

  function useScanner({ onScan, log }) {
    const IDLE_MS = 150;        // пауза, после которой код считается завершённым
    const MIN_LENGTH = 4;       // короче — это ручной ввод, не скан
    const FOCUS_POLL_MS = 500;

    const scanField = ref(null);
    const focused = ref(false);

    let fieldTimer = null;
    let bufferTimer = null;
    let poller = null;
    let buffer = '';
    let rebinding = false;

    const isTerminator = (e) =>
      e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9;

    const isButton = (el) => Boolean(el && el.closest && el.closest('.btn'));

    function submit(raw, source) {
      const code = String(raw || '').replace(/[\r\n\t]/g, '').trim();
      if (code) onScan(code, source);
    }

    /* --- Путь 1: сканер печатает в скрытое поле --- */

    function flushField() {
      clearTimeout(fieldTimer);
      const field = scanField.value;
      if (!field) return;
      const value = field.value;
      field.value = '';
      submit(value, 'поле');
    }

    function onFieldKeydown(e) {
      if (isTerminator(e)) {
        e.preventDefault();
        flushField();
      }
    }

    function onFieldInput() {
      // Сканер может не отправлять Enter — тогда код закрывается по паузе
      clearTimeout(fieldTimer);
      fieldTimer = setTimeout(flushField, IDLE_MS);
    }

    /* --- Путь 2: клавиши прошли мимо поля --- */

    function flushBuffer() {
      clearTimeout(bufferTimer);
      const value = buffer;
      buffer = '';
      if (value.length >= MIN_LENGTH) submit(value, 'документ');
    }

    function onDocumentKeydown(e) {
      if (e.target && e.target.tagName === 'INPUT') return;   // обработано путём 1

      if (isTerminator(e)) {
        e.preventDefault();
        flushBuffer();
        return;
      }
      if (e.key && e.key.length === 1) {
        buffer += e.key;
        clearTimeout(bufferTimer);
        bufferTimer = setTimeout(flushBuffer, IDLE_MS);
      }
    }

    /* --- Удержание фокуса --- */

    function applyFocus() {
      const field = scanField.value;
      if (!field) return;
      // readonly-поле принимает фокус, но не поднимает экранную клавиатуру;
      // флаг снимается сразу, поэтому приём символов через IME сохраняется
      field.readOnly = true;
      try {
        field.focus({ preventScroll: true });
      } catch (e) {
        field.focus();
      }
      setTimeout(() => { field.readOnly = false; }, 60);
    }

    function keepFocus() {
      if (rebinding || document.activeElement === scanField.value) return;
      applyFocus();
    }

    /* Полная пересборка связи с методом ввода. После выхода из спящего режима
       activeElement всё ещё указывает на поле, хотя соединение с IME уже
       разорвано, — обычная фокусировка такую ситуацию не распознаёт. */
    function rebind(reason) {
      const field = scanField.value;
      if (rebinding || !field) return;

      rebinding = true;
      log('пересборка ввода: ' + reason);
      field.blur();
      field.value = '';
      buffer = '';

      setTimeout(() => {
        rebinding = false;
        applyFocus();
      }, 120);
    }

    /* --- Слушатели документа --- */

    // Тап по кнопке не должен уводить фокус: иначе возврат фокуса произойдёт
    // внутри жеста пользователя и Android покажет экранную клавиатуру
    const onPointerDown = (e) => { if (isButton(e.target)) e.preventDefault(); };
    const onTap = (e) => { if (!isButton(e.target)) setTimeout(keepFocus, 30); };
    const onWake = () => rebind('пробуждение');
    const onVisibility = () => { if (!document.hidden) rebind('возврат в приложение'); };

    onMounted(() => {
      document.addEventListener('keydown', onDocumentKeydown);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('mousedown', onPointerDown, true);
      document.addEventListener('touchstart', onTap);
      document.addEventListener('click', onTap);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onWake);
      window.addEventListener('pageshow', onWake);

      poller = setInterval(() => {
        keepFocus();
        focused.value = document.activeElement === scanField.value;
      }, FOCUS_POLL_MS);

      applyFocus();
    });

    onBeforeUnmount(() => {
      document.removeEventListener('keydown', onDocumentKeydown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onTap);
      document.removeEventListener('click', onTap);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
      clearInterval(poller);
      clearTimeout(fieldTimer);
      clearTimeout(bufferTimer);
    });

    return { scanField, focused, onFieldKeydown, onFieldInput, rebind };
  }

  /* ------------------------------------------------------------------ */
  /*  Сохранение состояния сборки                                        */
  /* ------------------------------------------------------------------ */

  function useStorage(log) {
    function read() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      } catch (e) {
        log('состояние не прочитано: ' + e.message);
        return {};
      }
    }

    function write(state) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        log('состояние не сохранено: ' + e.message);
      }
    }

    return { read, write };
  }

  /* ------------------------------------------------------------------ */
  /*  Приложение                                                         */
  /* ------------------------------------------------------------------ */

  createApp({
    setup() {
      const { entries: log, push: write, clear: clearLog } = useLog();
      const signals = useSignals(write);
      const storage = useStorage(write);

      const saved = storage.read();
      const items = reactive(
        CATALOG.map((product) => ({ ...product, collected: Boolean(saved[product.barcode]) }))
      );

      const IDLE_STATUS = 'Отсканируйте товар';
      const diagOpen = ref(false);
      const status = reactive({ text: IDLE_STATUS, kind: '' });
      let statusTimer = null;

      const collectedCount = computed(() => items.filter((item) => item.collected).length);

      function setStatus(text, kind = '') {
        status.text = text;
        status.kind = kind;
        clearTimeout(statusTimer);
        if (text !== IDLE_STATUS) {
          statusTimer = setTimeout(() => setStatus(IDLE_STATUS), 4000);
        }
      }

      function handleScan(code, source) {
        write(`скан [${source}]: ${code}`);
        const item = items.find((candidate) => candidate.barcode === code);

        if (!item) {
          signals.error(2);
          setStatus('Неизвестный штрихкод\n' + code, 'err');
          return;
        }
        if (item.collected) {
          signals.error(3);
          setStatus(`ПЕРЕБОР! ${item.sku} уже собран`, 'err');
          return;
        }

        item.collected = true;
        signals.success();
        setStatus('Собран: ' + item.sku, 'ok');
      }

      const scanner = useScanner({ onScan: handleScan, log: write });

      watch(
        items,
        () => storage.write(items.reduce((state, item) => {
          state[item.barcode] = item.collected;
          return state;
        }, {})),
        { deep: true }
      );

      function reset() {
        items.forEach((item) => { item.collected = false; });
        setStatus('Список сброшен');
        write('сброс списка');
      }

      function reconnect() {
        scanner.rebind('вручную');
        setStatus('Ввод переподключён');
      }

      onMounted(() => write('запуск: ' + navigator.userAgent.slice(0, 80)));

      return {
        items,
        collectedCount,
        status,
        log,
        diagOpen,
        reset,
        reconnect,
        clearLog,
        testSuccess: () => signals.success(),
        testError: () => signals.error(3),
        testScan: () => handleScan(CATALOG[0].barcode, 'тест'),
        scanField: scanner.scanField,
        focused: scanner.focused,
        onFieldKeydown: scanner.onFieldKeydown,
        onFieldInput: scanner.onFieldInput
      };
    }
  }).mount('#app');
})();
