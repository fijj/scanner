/* global Vue */
(function () {
  'use strict';

  const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue;

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
  /*  Приём штрихкодов                                                   */
  /* ------------------------------------------------------------------ */

  /*  Основной режим — перехват key-событий на документе. Ни один элемент
      не держит фокус, и это принципиально: Chromium на каждом тапе вызывает
      showImeIfNeeded(), и если фокус в этот момент удерживает редактируемое
      поле, Android поднимает экранную клавиатуру — независимо от того, куда
      пришёлся тап. Поэтому поле-приёмник по умолчанию readonly и не в фокусе.

      Режим IME нужен лишь тем сканерам, которые отдают штрихкод не клавишами,
      а вставкой текста через метод ввода: такому сканеру необходимо
      сфокусированное редактируемое поле, и клавиатура в этом режиме возможна.  */

  function useScanner({ onScan, log, imeMode }) {
    const IDLE_MS = 150;        // пауза, после которой код считается завершённым
    const MIN_LENGTH = 4;       // короче — это не штрихкод
    const POLL_MS = 500;
    const SIGNAL_MS = 200;

    const scanField = ref(null);
    const signal = ref(false);  // индикатор: от сканера пришли данные

    let fieldTimer = null;
    let bufferTimer = null;
    let signalTimer = null;
    let poller = null;
    let buffer = '';
    let rebinding = false;

    const isTerminator = (e) =>
      e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9;

    function flash() {
      signal.value = true;
      clearTimeout(signalTimer);
      signalTimer = setTimeout(() => { signal.value = false; }, SIGNAL_MS);
    }

    function submit(raw, source) {
      const code = String(raw || '').replace(/[\r\n\t]/g, '').trim();
      if (code) onScan(code, source);
    }

    /* --- Перехват клавиш на документе (основной путь) --- */

    function flushBuffer() {
      clearTimeout(bufferTimer);
      const value = buffer;
      buffer = '';
      if (value.length >= MIN_LENGTH) submit(value, 'клавиши');
    }

    function onDocumentKeydown(e) {
      if (e.target === scanField.value) return;   // обработано полем в режиме IME
      flash();

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

    /* --- Приём через поле-приёмник (режим IME) --- */

    function flushField() {
      clearTimeout(fieldTimer);
      const field = scanField.value;
      if (!field) return;
      const value = field.value;
      field.value = '';
      submit(value, 'IME');
    }

    function onFieldKeydown(e) {
      flash();
      if (isTerminator(e)) {
        e.preventDefault();
        flushField();
      }
    }

    function onFieldInput() {
      flash();
      // Сканер может не отправлять Enter — тогда код закрывается по паузе
      clearTimeout(fieldTimer);
      fieldTimer = setTimeout(flushField, IDLE_MS);
    }

    /* --- Фокус: нужен исключительно в режиме IME --- */

    function applyFocus() {
      const field = scanField.value;
      if (!field) return;
      try {
        field.focus({ preventScroll: true });
      } catch (e) {
        field.focus();
      }
    }

    function keepFocus() {
      if (!imeMode.value || rebinding) return;
      if (document.activeElement === scanField.value) return;
      applyFocus();
    }

    /* Пересборка связи с методом ввода. После выхода из спящего режима
       activeElement всё ещё указывает на поле, хотя соединение с IME уже
       разорвано, — обычная фокусировка такую ситуацию не распознаёт. */
    function rebind(reason) {
      buffer = '';
      const field = scanField.value;

      if (!imeMode.value) {
        log('буфер очищен: ' + reason);
        return;
      }
      if (rebinding || !field) return;

      rebinding = true;
      log('пересборка ввода: ' + reason);
      field.blur();
      field.value = '';

      setTimeout(() => {
        rebinding = false;
        applyFocus();
      }, 120);
    }

    watch(imeMode, (on) => {
      log('режим приёма: ' + (on ? 'через поле (IME)' : 'клавиши'));
      if (on) applyFocus();
      else if (scanField.value) scanField.value.blur();
    });

    const onVisibility = () => { if (!document.hidden) rebind('возврат в приложение'); };
    const onWake = () => rebind('пробуждение');

    onMounted(() => {
      document.addEventListener('keydown', onDocumentKeydown);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onWake);
      window.addEventListener('pageshow', onWake);

      poller = setInterval(keepFocus, POLL_MS);
      if (imeMode.value) applyFocus();
    });

    onBeforeUnmount(() => {
      document.removeEventListener('keydown', onDocumentKeydown);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
      clearInterval(poller);
      clearTimeout(fieldTimer);
      clearTimeout(bufferTimer);
      clearTimeout(signalTimer);
    });

    return { scanField, signal, onFieldKeydown, onFieldInput, rebind };
  }

  /* ------------------------------------------------------------------ */
  /*  Хранилище                                                          */
  /* ------------------------------------------------------------------ */

  function useStorage(key, log) {
    function read() {
      try {
        return JSON.parse(localStorage.getItem(key)) || {};
      } catch (e) {
        log(`${key}: не прочитано (${e.message})`);
        return {};
      }
    }

    function write(state) {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch (e) {
        log(`${key}: не сохранено (${e.message})`);
      }
    }

    return { read, write };
  }

  /* ------------------------------------------------------------------ */
  /*  Приложение                                                         */
  /* ------------------------------------------------------------------ */

  /*  Service worker даёт офлайн-работу и установку на главный экран.
      Регистрация возможна только на защищённом origin (https или localhost);
      при открытии файла напрямую через file:// её просто не будет.  */
  function registerServiceWorker(log) {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      log('офлайн-режим недоступен: нужен https или localhost');
      return;
    }
    navigator.serviceWorker.register('sw.js')
      .then(() => log('офлайн-режим включён'))
      .catch((e) => log('service worker не зарегистрирован: ' + e.message));
  }

  createApp({
    setup() {
      const IDLE_STATUS = 'Отсканируйте товар';

      const { entries: log, push: write, clear: clearLog } = useLog();
      const signals = useSignals(write);
      const progress = useStorage('scanner.collected.v1', write);
      const settings = useStorage('scanner.settings.v1', write);

      const saved = progress.read();
      const items = reactive(
        CATALOG.map((product) => ({ ...product, collected: Boolean(saved[product.barcode]) }))
      );

      const imeMode = ref(Boolean(settings.read().imeMode));
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

      const scanner = useScanner({ onScan: handleScan, log: write, imeMode });

      watch(
        items,
        () => progress.write(items.reduce((state, item) => {
          state[item.barcode] = item.collected;
          return state;
        }, {})),
        { deep: true }
      );

      watch(imeMode, (on) => settings.write({ imeMode: on }));

      function reset() {
        items.forEach((item) => { item.collected = false; });
        setStatus('Список сброшен');
        write('сброс списка');
      }

      function reconnect() {
        scanner.rebind('вручную');
        setStatus('Ввод переподключён');
      }

      onMounted(() => {
        write('запуск: ' + navigator.userAgent.slice(0, 80));
        registerServiceWorker(write);
      });

      return {
        items,
        collectedCount,
        status,
        log,
        diagOpen,
        imeMode,
        reset,
        reconnect,
        clearLog,
        testSuccess: () => signals.success(),
        testError: () => signals.error(3),
        testScan: () => handleScan(CATALOG[0].barcode, 'тест'),
        scanField: scanner.scanField,
        signal: scanner.signal,
        onFieldKeydown: scanner.onFieldKeydown,
        onFieldInput: scanner.onFieldInput
      };
    }
  }).mount('#app');
})();
