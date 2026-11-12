/* AI-Audition — помощник и файлы на сервере внутри звукового редактора.
 *
 * Панель в браузере разговаривает с моделью через api/assistant.php, а действия
 * выполняет в самом редакторе через window.aiaudition (apps/soundcraft-web/src/web/bridge.rs):
 * те же методы, что у десктопного канала управления (crates/ui-egui/src/control.rs).
 * Файлы хранятся на вашем сервере (api/files.php), у каждого пользователя свои.
 *
 * Без сборщиков и зависимостей: один файл, подключается из index.html.
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    api: 'api/assistant.php',
    files: 'api/files.php',
    homeUrl: '../',
    labels: 'studio/ru-labels.json',
    autosaveSeconds: 120,      // автосохранение на сервер проекта, который там уже лежит (0 — выключить)
    maxSteps: 40,              // шагов подряд в «Сделай» по умолчанию (в панели: шестерёнка → 10…без ограничений)
    screenshotMax: 1280,       // длинная сторона снимка экрана для модели, px
    openOnStart: false,
    filesOnStart: true,
    aiMaxChars: 60000,         // сколько символов (не больше) отправлять для «ИИ у выделения»
  }, window.STUDIO_CONFIG || {});
  // Страница сборки лежит в b/<номер>/ (studio/build/versioned.sh); адреса из настроек — от папки приложения.
  const fromRoot = (p) => { try { return new URL(p, window.STUDIO_ROOT || document.baseURI).href; } catch { return p; } };
  CFG.api = fromRoot(CFG.api);
  CFG.files = CFG.files ? fromRoot(CFG.files) : CFG.files;
  CFG.homeUrl = fromRoot(CFG.homeUrl || '../');
  // Редактор сам читает адрес домика из настроек.
  window.STUDIO_CONFIG = Object.assign(window.STUDIO_CONFIG || {}, { homeUrl: CFG.homeUrl });

  const READ_TOOLS = new Set(['find_commands', 'get_state', 'track_details', 'look_at_screen']);
  // Никогда: файлы (их делает панель), служебное и интерфейс, настройки устройства, импорт и экспорт по путям.
  const DENY = /^(app\.|ui\.|window\.|test\.|session\.(new|open|close|save|revert)|file\.(import|export|send_to|print|score|get_info)|setup\.(hardware|preferences)|track\.(save|load)_preset|mix\.sampler_load|clip\.capture|engine\.parity)/i;
  // Только после подтверждения пользователя.
  const CONFIRM = /^(track\.delete|clip\.clear|edit\.clear\b|event\.cut_time|markers\.delete|automation\.clear|edit\.clear_all_automation)/i;

  // ------------------------------------------------------------------ мост к редактору
  const VC = () => window.aiaudition;
  const PC = {
    ready: () => !!(VC() && typeof VC().request === 'function'),
    async call(method, params) {
      if (!PC.ready()) throw new Error('Редактор ещё загружается');
      return VC().request(method, params ?? {});
    },
    exec(id, params) {
      const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
      return PC.call('engine.execute', { command: id, params: p });
    },
  };
  // Для своих скриптов и отладки из консоли: await aiauditionStudio.exec('track.new', {count: 1, format: 'mono'})
  window.aiauditionStudio = { call: PC.call, exec: PC.exec };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what + ': нет ответа'); })]);
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…[обрезано]' : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('aiaudition.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('aiaudition.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  // ------------------------------------------------------------------ русские названия
  let L = { text: {}, id: {} };
  const labelsLoaded = fetch(CFG.labels).then((r) => (r.ok ? r.json() : L)).then((j) => { L = j; }).catch(() => {});
  function ru(label) {
    if (!label) return '';
    if (L.text[label]) return L.text[label];
    const bare = label.replace(/(…|\.\.\.)$/, '');
    if (bare !== label && L.text[bare]) return L.text[bare] + '…';
    return label;
  }
  // Путь в меню: у команд движка — список, у команд интерфейса — строка «Window > Mix».
  const menuOf = (c) => (Array.isArray(c.menu) ? c.menu : String(c.location || c.menu || '').split(/›|>/)).map((x) => String(x).trim()).filter(Boolean);
  const ruName = (c) => L.id[c.id] || ru(c.label);
  const ruPath = (c) => [...menuOf(c).map(ru), ruName(c)].join(' › ');

  // ------------------------------------------------------------------ поиск команд
  let catalog = null;
  let catalogAt = 0;
  async function commands() {
    if (!catalog || Date.now() - catalogAt > 30000) {
      const r = await PC.call('engine.commands');
      catalog = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
      catalogAt = Date.now();
    }
    return catalog;
  }
  // Частые просьбы → слова, которыми такие команды называются.
  const SYN = [
    [/тишин|пауз/, 'strip silence space clips'], [/нормализ|выровн\S* громк|громкост/, 'normalize gain volume audiosuite'], [/усилен/, 'gain clip'],
    [/фейд|затуха|нарастан|плавн/, 'fades fade create'], [/кроссфейд|перекрест/, 'fades crossfade'], [/разрез|разделит|резать/, 'separate'],
    [/обрез|подрез|тримм/, 'trim'], [/удал/, 'clear delete'], [/вставит|вставк/, 'paste insert'], [/копир/, 'copy duplicate'], [/дубл|повтор/, 'duplicate repeat'],
    [/склеит|объедин|сомкн/, 'heal consolidate space clips'], [/сдвин|перемест|сместит/, 'move nudge shift'], [/выдел/, 'select selection'],
    [/маркер|метк|глав/, 'memory location marker markers'], [/дорожк|трек/, 'track'], [/нов\S* дорожк|добав\S* дорожк/, 'track new'],
    [/переимен|назван|имя/, 'rename name'], [/коммент/, 'comments'], [/цвет/, 'color'], [/громкость дорожк|фейдер/, 'volume mix'], [/панорам/, 'pan'],
    [/заглуш|выключ\S* звук|mute/, 'mute'], [/соло/, 'solo'], [/эффект|плагин|обработк/, 'insert plugin audiosuite'], [/эквалайз|частот|низ|верх|срез/, 'eq hpf'],
    [/компресс|сжат/, 'compressor dynamics'], [/лимит|максимайз/, 'maximizer limiter'], [/шипящ|свист|де-?эсс/, 'de-esser'], [/шум|гейт|ворот/, 'expander gate'],
    [/ревер|эхо|зал/, 'reverb delay'], [/реверс|задом/, 'reverse'], [/тон|высот/, 'pitch shift'], [/темп|скорост|растян/, 'time stretch tempo varispeed'],
    [/свест|сведени|экспорт|bounce|скачат/, 'bounce mix'], [/стем/, 'bounce stems'], [/запис/, 'record arm'], [/воспроизв|играт|стоп/, 'transport play stop'],
    [/масштаб|зум/, 'zoom view'], [/отмен/, 'undo'], [/автоматизац/, 'automation'], [/посыл|aux|шин/, 'send bus aux'], [/midi|мили|нот/, 'midi note'],
  ];
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  async function findCommands(query) {
    const all = await commands();
    await labelsLoaded;
    const q = norm(query).trim();
    if (!q) return { results: [], hint: 'Пустой запрос' };
    const terms = new Set(q.split(/[^\p{L}\p{N}.]+/u).filter((t) => t.length > 1));
    for (const [re, words] of SYN) if (re.test(q)) words.split(' ').forEach((w) => terms.add(w));
    const scored = [];
    for (const c of all) {
      if (DENY.test(c.id)) continue;
      const name = norm(ruName(c));
      const en = norm(c.label);
      const path = norm(menuOf(c).map(ru).join(' ') + ' ' + menuOf(c).join(' '));
      const id = norm(c.id);
      let s = 0;
      if (name === q || en === q) s += 20;
      else if (name.includes(q) || en.includes(q)) s += 10;
      for (const t of terms) {
        if (name.includes(t)) s += name.startsWith(t) ? 7 : 5;
        if (en.includes(t)) s += en.startsWith(t) ? 6 : 4;
        if (id.includes(t)) s += 3;
        if (path.includes(t)) s += 1;
      }
      if (s > 0) scored.push([s + (c.params && c.params !== '{}' ? 1 : 0), c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const results = scored.slice(0, 10).map(([, c]) => ({
      id: c.id,
      name: ruName(c),
      menu: ruPath(c),
      shortcut: c.shortcut || undefined,
      params: c.params && c.params !== '{}' ? clip(String(c.params), 600) : undefined,
    }));
    return results.length ? { results } : { results: [], hint: 'Ничего не найдено. Попробуй другие слова, можно по-английски (например: strip silence, normalize, fades, marker, track, insert, bounce).' };
  }
  // ------------------------------------------------------------------ состояние и снимок экрана
  // Время в движке — отсчёты (samples); модели и человеку — секунды.
  const secs = (n, sr) => (Number.isFinite(Number(n)) && sr > 0 ? Math.round((Number(n) / sr) * 100) / 100 : n);
  const KIND_RU = { audio: 'аудио', midi: 'MIDI', instrument: 'инструмент', aux: 'AUX', master: 'мастер', vca: 'VCA', folder: 'папка', video: 'видео' };
  async function session(detail) {
    return PC.call('session.inspect', detail ? { detail } : {});
  }
  // Клип кратко: имя, где и сколько (секунды), усиление и фейды.
  function clipSummary(c, sr) {
    const o = { id: c.id, name: c.name, start: secs(c.start, sr), length: secs(c.length, sr) };
    if (c.gain_db) o.gain_db = Math.round(c.gain_db * 10) / 10;
    if (c.fade_in) o.fade_in = secs(c.fade_in, sr);
    if (c.fade_out) o.fade_out = secs(c.fade_out, sr);
    if (c.muted) o.muted = true;
    if (c.notes != null) o.midi_notes = c.notes;
    return o;
  }
  function trackSummary(t, sr, maxClips) {
    const o = { id: t.id, name: t.name, kind: t.kind, format: t.format, volume_db: Math.round((t.volume_db || 0) * 10) / 10 };
    if (t.pan) o.pan = t.pan;
    if (t.mute) o.mute = true;
    if (t.solo) o.solo = true;
    if (t.inactive) o.inactive = true;
    if (t.comments) o.comments = clip(String(t.comments), 300);
    const inserts = (t.inserts || []).map((x) => `${'abcdefghij'[x.slot] || x.slot}:${x.plugin}${x.bypass ? ' (обход)' : ''}`);
    if (inserts.length) o.inserts = inserts;
    const clips = t.clips || [];
    o.clips = clips.slice(0, maxClips).map((c) => clipSummary(c, sr));
    if (clips.length > maxClips) o.more_clips = clips.length - maxClips;
    return o;
  }
  // Текущий проект: имя, сохранён ли, частота, длина, дорожки с клипами, маркеры, выделение.
  async function snapshot() {
    const state = {};
    try {
      const d = await session();
      const sr = Number(d.sample_rate) || 48000;
      state.project = d.name;
      state.unsaved = !!d.dirty;
      state.onServer = !!d.path && Files.isServer(d.path);
      state.sample_rate = sr;
      state.length_seconds = secs(d.length_samples, sr);
      const tracks = d.tracks || [];
      state.tracks = tracks.slice(0, 32).map((t) => trackSummary(t, sr, 25));
      if (tracks.length > 32) state.more_tracks = tracks.length - 32;
      state.markers = (d.markers || []).slice(0, 60).map((m) => ({ number: m.number, name: m.name, at: secs(m.start, sr), ...(m.end && m.end !== m.start ? { end: secs(m.end, sr) } : {}) }));
      const sel = d.selection || {};
      state.selection = { start: secs(sel.start, sr), end: secs(sel.end, sr), tracks: sel.tracks || [], clips: sel.clips || [] };
      if (d.transport) state.playhead = secs(d.transport.position, sr);
      state.edit_mode = d.edit_mode;
      if (!tracks.length) state.note = 'В проекте нет дорожек. Звук можно открыть из «Моих проектов» или с компьютера (Файл › Импорт › Звук), или создать дорожку: track.new.';
    } catch (e) {
      state.note = 'Редактор ещё загружается: ' + e.message;
    }
    return state;
  }
  // Одна дорожка подробно: все клипы, эффекты с параметрами, посылы, автоматизация.
  async function trackDetails(ref) {
    const d = await session();
    const sr = Number(d.sample_rate) || 48000;
    const key = String(ref ?? '').trim();
    const t = (d.tracks || []).find((x) => String(x.id) === key) || (d.tracks || []).find((x) => norm(x.name) === norm(key));
    if (!t) throw new Error(`Нет дорожки «${key}». Список дорожек — в get_state.`);
    const full = await PC.exec('track.inspect', { track: t.id });
    const o = trackSummary(full, sr, 200);
    o.inserts = (full.inserts || []).map((x) => ({ slot: 'abcdefghij'[x.slot] || x.slot, plugin: x.plugin, bypass: !!x.bypass, params: x.params }));
    if ((full.sends || []).length) o.sends = full.sends;
    if ((full.automation || []).length) o.automation = full.automation.map((l) => ({ param: l.param, points: Array.isArray(l.points) ? l.points.length : l.points }));
    return o;
  }

  function downscale(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, CFG.screenshotMax / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75).split(',')[1]);
      };
      img.onerror = () => reject(new Error('не удалось прочитать снимок'));
      img.src = src;
    });
  }
  async function screenshot() {
    if (!PC.ready()) return null;
    try {
      const r = await withTimeout(VC().screenshot(), 9000, 'снимок');
      const b64 = r && (r.png_base64 || r.png || r.pngBase64 || r.data);
      if (typeof b64 === 'string' && b64.length > 100) return await downscale('data:image/png;base64,' + b64);
    } catch { /* ниже */ }
    return null;
  }

  // ------------------------------------------------------------------ интерфейс
  const ICON = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-9 9H5v-6z"/><path d="M12.5 5.5l6 6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2.2a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16.5" cy="10.5" r="1.2"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    // Мозг — контур из набора Tabler Icons (MIT), нарисованный градиентом #st-brain-grad.
    brain: '<svg class="st-brain-svg" viewBox="0 0 24 24" fill="none" stroke="url(#st-brain-grad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8"/><path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8"/><path d="M17.5 16a3.5 3.5 0 0 0 0 -7h-.5"/><path d="M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0"/><path d="M6.5 16a3.5 3.5 0 0 1 0 -7h.5"/><path d="M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3l-8 11h6l-1 7 8-11h-6z"/></svg>',
  };
  // Живой контур: мозг градиентом и три точки на орбите, пока помощник работает.
  const BRAIN = `${ICON.brain}<b class="st-orbit" aria-hidden="true"><i></i><i></i><i></i></b>`;

  const root = document.createElement('div');
  root.id = 'studio-root';
  root.dataset.theme = 'light';
  root.innerHTML = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="st-brain-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fa2ff"/><stop offset=".55" stop-color="#9b7cf0"/><stop offset="1" stop-color="#ff77c6"/></linearGradient></defs></svg>
    <div class="st-veil" aria-hidden="true"></div>
    <div class="st-drop" aria-hidden="true"><span>Отпустите, чтобы открыть в редакторе</span></div>
    <aside class="st-panel" aria-label="Помощник">
      <header class="st-head">
        <div class="st-logo st-brain st-raised-sm" aria-hidden="true">${BRAIN}</div>
        <div class="st-title"><b>Помощник</b><small data-ref="sub">Загрузка редактора…</small></div>
        <button class="st-icon-btn" data-ref="galleryBtn" title="Быстрые задачи: тишина, громкость, подготовка к подкасту, сведение…" aria-label="Быстрые задачи">${ICON.layout}</button>
        <button class="st-icon-btn" data-ref="filesBtn" title="Мои файлы (на сервере)" aria-label="Мои файлы">${ICON.folder}</button>
        <button class="st-icon-btn" data-ref="barBtn" title="Быстрая строка (Ctrl+Shift+Пробел)" aria-label="Быстрая строка">${ICON.bolt}</button>
        <div class="st-theme-wrap">
          <button class="st-icon-btn" data-ref="theme" title="Тема оформления" aria-label="Тема оформления" aria-haspopup="menu" aria-expanded="false">${ICON.palette}</button>
          <div class="st-theme-menu" data-ref="themeMenu" role="menu" hidden></div>
        </div>
        <button class="st-icon-btn" data-ref="hide" title="Свернуть панель" aria-label="Свернуть панель">${ICON.close}</button>
      </header>
      <div class="st-seg st-pressed" role="group" aria-label="Режим помощника">
        <button data-mode="advice" aria-pressed="true">${ICON.bulb}Совет</button>
        <button data-mode="act" aria-pressed="false">${ICON.hand}Сделай</button>
      </div>
      <div class="st-mode-hint" data-ref="hint"></div>
      <div class="st-log" data-ref="log" role="log" aria-live="polite"></div>
      <div class="st-composer">
        <div class="st-input st-pressed">
          <button class="st-icon-btn" data-ref="eye" aria-pressed="true" title="Показывать помощнику экран" aria-label="Показывать помощнику экран">${ICON.eye}</button>
          <textarea data-ref="input" rows="1" placeholder="Спросите или попросите…" aria-label="Сообщение помощнику"></textarea>
          <button class="st-send" data-ref="send" title="Отправить (Enter)" aria-label="Отправить">${ICON.send}</button>
        </div>
        <div class="st-foot"><span>Ctrl+Z — отменить</span><span class="st-agent-wrap"><button data-ref="agentBtn" title="Сколько шагов подряд делать и спрашивать ли перед удалением" aria-haspopup="menu" aria-expanded="false">${ICON.gear}Настройки</button><span class="st-theme-menu st-agent-menu" data-ref="agentMenu" role="menu" hidden></span></span><button data-ref="clear">Новый разговор</button></div>
      </div>
    </aside>
    <div class="st-files" data-ref="files" role="dialog" aria-modal="true" aria-label="Мои файлы" hidden>
      <div class="st-files-box">
        <header class="st-files-head">
          <b>Мои проекты</b><small data-ref="filesWho"></small>
          <button class="st-icon-btn" data-ref="filesClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-files-tools">
          <input data-ref="filesSearch" type="search" placeholder="Поиск по имени" aria-label="Поиск по имени">
          <button class="st-mini" data-ref="filesNew">Новый проект</button>
          <button class="st-mini" data-ref="filesUpload" title="Проект .scraftz или звук: WAV, MP3, FLAC, OGG, M4A… (звук — новой дорожкой)">С компьютера…</button>
        </div>
        <div class="st-files-list" data-ref="filesList"></div>
        <footer class="st-files-foot">
          <span data-ref="filesCurrent"></span>
          <button class="st-mini" data-ref="filesSaveAs">Сохранить как…</button>
          <button class="st-mini primary" data-ref="filesSave">Сохранить</button>
        </footer>
      </div>
    </div>
    <div class="st-files st-gallery" data-ref="gallery" role="dialog" aria-modal="true" aria-label="Быстрые задачи" hidden>
      <div class="st-files-box st-gallery-box">
        <header class="st-files-head">
          <b>Быстрые задачи</b>
          <small>В одно нажатие. Действуют на выделенные дорожки, а если ничего не выделено — на весь проект.</small>
          <button class="st-icon-btn" data-ref="galleryClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-gpane"><div class="st-gtasks" data-ref="gTasks"></div></div>
      </div>
    </div>
    <div class="st-ask" data-ref="ask" role="dialog" aria-modal="true" hidden>
      <form class="st-ask-box">
        <b data-ref="askTitle"></b>
        <input data-ref="askInput" type="text" maxlength="120">
        <small data-ref="askNote"></small>
        <div class="st-row"><button type="button" class="st-mini" data-ref="askCancel">Отмена</button><button type="submit" class="st-mini primary" data-ref="askOk">OK</button></div>
      </form>
    </div>
    <button class="st-fab st-brain" data-ref="fab" title="Помощник" aria-label="Открыть помощника">${BRAIN}<span class="st-badge" aria-hidden="true"></span></button>
    <div class="st-bar" data-ref="bar" role="dialog" aria-label="Быстрая строка помощника">
      <div class="st-bar-answer" data-ref="barAnswer"></div>
      <div class="st-bar-row">
        <button class="st-bar-mode" data-ref="barMode" title="Режим: Совет или Сделай"></button>
        <input data-ref="barInput" type="text" placeholder="Что сделать со звуком? Enter — отправить, Esc — закрыть" aria-label="Запрос помощнику">
        <button class="st-send" data-ref="barSend" aria-label="Отправить">${ICON.send}</button>
      </div>
    </div>`;
  const $ = (name) => root.querySelector(`[data-ref="${name}"]`);
  const log = $('log');
  const input = $('input');

  // Клавиши, набранные в панели, не должны доходить до редактора (иначе «B» выберет кисть).
  for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  let mode = store.get('mode', 'advice');
  let attachScreen = store.get('eye', true);
  let busy = false;
  let stopRequested = false;
  let convo = [];

  const HINTS = {
    advice: 'Объясняю и подсказываю, ничего не меняю в проекте.',
    act: 'Делаю сам: режу и склеиваю, убираю тишину, выравниваю громкость, ставлю эффекты, фейды и маркеры, свожу. Всё отменяется Ctrl+Z.',
  };
  // Модель видит всю переписку. Если раньше она писала «я в режиме Совет», то по инерции продолжает
  // так отвечать и после переключения. Поэтому смена режима отмечается прямо в разговоре,
  // а каждое сообщение пользователя несёт текущий режим.
  const MODE_NOTE = {
    act: '[Режим переключён на «Сделай». Теперь ты сам выполняешь просьбы инструментами (get_state, run_command, select_time…). Всё, что ты раньше писал про режим «Совет», больше не действует.]',
    advice: '[Режим переключён на «Совет». Теперь только объясняй и подсказывай, ничего не меняй в проекте.]',
  };
  const MODE_TAG = {
    act: '[Режим сейчас: «Сделай» — выполни это сам, инструментами]',
    advice: '[Режим сейчас: «Совет» — объясни, как сделать, ничего не меняя]',
  };
  function setMode(m) {
    const next = m === 'act' ? 'act' : 'advice';
    if (next !== mode && convo.length) convo.push({ role: 'user', content: MODE_NOTE[next] });
    mode = next;
    store.set('mode', mode);
    root.querySelectorAll('.st-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('hint').textContent = HINTS[mode];
    const bm = root.querySelector('[data-ref="barMode"]');
    if (bm) bm.textContent = mode === 'act' ? 'Сделай' : 'Совет';
  }
  function setEye(on) {
    attachScreen = !!on;
    store.set('eye', attachScreen);
    $('eye').setAttribute('aria-pressed', String(attachScreen));
    $('eye').title = attachScreen ? 'Помощник видит экран' : 'Помощник не видит экран';
  }
  function setOpen(open) {
    root.classList.toggle('open', open);
    document.body.classList.toggle('studio-open', open);
    setTimeout(syncBackdrop, 60);
    setTimeout(syncBackdrop, 400);
    store.set('open', open);
    // eframe подхватывает новый размер canvas на следующем кадре
    window.dispatchEvent(new Event('resize'));
    if (open) { setTimeout(() => input.focus(), 200); root.classList.remove('has-hints'); }
  }
  function setBusy(on) {
    busy = on;
    root.classList.toggle('busy', on);
    $('send').innerHTML = on ? ICON.stop : ICON.send;
    $('send').title = on ? 'Остановить' : 'Отправить (Enter)';
  }
  function scroll() { log.scrollTop = log.scrollHeight; }

  function format(text) {
    // Строки списка «- …» / «* …» — с точкой; короткая строка, оканчивающаяся двоеточием, — заголовок.
    text = text.trim().split('\n').map((line) => {
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (li) return '\u0001' + (/^\s*\d/.test(line) ? line.trim().match(/^\d+[.)]/)[0] + ' ' : '• ') + li[1] + '\u0002';
      const head = line.match(/^\s*(?:#{1,4}\s*)?\**([^*:]{2,60}):\**\s*$/);
      if (head) return '\u0003' + head[1] + ':\u0004';
      return line.replace(/^#{1,4}\s+/, '');
    }).join('\n').replace(/\u0002\n/g, '\u0002');  // пункт списка — блок: перенос после него лишний
    let h = esc(text);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/\((Ctrl|Shift|Alt|Cmd|⌘|⇧|⌥)([^)\n]{0,24})\)/g, '(<kbd>$1$2</kbd>)');
    // «Изображение › Коррекция › Кривые» — путь в меню
    // Сегменты — слова через одиночные пробелы: конечный пробел не должен «съедать» разделитель.
    const C = '[^\\s›«»"():.,!?;<>&]';
    const word = `${C}+`;
    const path = new RegExp(`([А-ЯЁA-Z]${C}*(?: ${word}){0,2}(?: › ${word}(?: ${word}){0,3}){1,4})`, 'g');
    h = h.replace(path, '<span class="st-path">$1</span>');
    h = h.replace(/\u0001/g, '<span class="st-li">').replace(/\u0002/g, '</span>')
      .replace(/\u0003/g, '<span class="st-h">').replace(/\u0004/g, '</span>');
    return h;
  }
  function add(el) { log.querySelector('.st-empty')?.remove(); log.appendChild(el); scroll(); return el; }
  function msg(cls, html) { const d = document.createElement('div'); d.className = 'st-msg ' + cls; d.innerHTML = html; return add(d); }
  function typing(on) {
    log.querySelector('.st-typing')?.remove();
    if (on) { const t = document.createElement('div'); t.className = 'st-typing st-raised-sm'; t.innerHTML = '<i></i><i></i><i></i>'; add(t); }
  }

  const ACTION_TEXT = {
    find_commands: (a) => ['Ищу команду', a.query],
    get_state: () => ['Смотрю проект', ''],
    track_details: (a) => ['Смотрю дорожку', a.track != null ? String(a.track) : ''],
    select_time: (a) => ['Выделяю', [Array.isArray(a.tracks) && a.tracks.length ? a.tracks.join(', ') : 'все дорожки', a.start != null || a.end != null ? `${a.start ?? 0}–${a.end ?? 'конец'} с` : 'весь проект'].join(' · ')],
    look_at_screen: () => ['Смотрю на экран', ''],
    undo: (a) => ['Отменяю', `${a.steps || 1} шаг(а)`],
  };
  function card(name, args, label) {
    const d = document.createElement('div');
    const [title, detail] = label || (ACTION_TEXT[name] ? ACTION_TEXT[name](args) : [name, '']);
    d.className = 'st-act' + (READ_TOOLS.has(name) ? ' read' : '');
    d.innerHTML = `<span class="st-dot"></span><div class="st-act-text"><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
    return add(d);
  }
  function cardResult(d, ok, error, undoable) {
    if (!ok) {
      d.classList.add('fail');
      const s = d.querySelector('small') || d.querySelector('.st-act-text').appendChild(document.createElement('small'));
      s.textContent = error;
      return;
    }
    if (undoable) {
      const b = document.createElement('button');
      b.className = 'st-mini';
      b.textContent = 'Отменить';
      b.onclick = async () => {
        b.disabled = true;
        const steps = typeof undoable === 'number' ? undoable : 1;
        try { for (let i = 0; i < steps; i++) await PC.exec('edit.undo'); b.textContent = 'Отменено'; } catch (e) { b.textContent = 'Не вышло'; b.title = e.message; }
      };
      d.appendChild(b);
    }
  }
  // ------------------------------------------------------------------ настройки помощника
  // Сколько шагов подряд делать в «Сделай» (потом — кнопка «Продолжить») и спрашивать ли перед
  // удалением, закрытием, сбросом. Хранятся в этом браузере; меню — «Настройки» внизу панели.
  const STEP_CHOICES = [10, 25, 40, 100, 0]; // 0 — без ограничений
  const stepSetting = () => { const v = Number(store.get('agentSteps', CFG.maxSteps)); return Number.isFinite(v) && v >= 0 ? v : CFG.maxSteps; };
  const agentSteps = () => (stepSetting() > 0 ? stepSetting() : Infinity);
  const askBeforeRisky = () => store.get('agentConfirm', true) !== false;
  function renderAgentMenu() {
    const menu = $('agentMenu');
    if (!menu) return;
    const cur = stepSetting();
    menu.innerHTML = '<div class="st-menu-title">Шагов подряд в «Сделай»</div>'
      + STEP_CHOICES.map((n) => `<button role="menuitemradio" aria-checked="${n === cur}" data-steps="${n}">${n ? n : 'Без ограничений'}</button>`).join('')
      + '<hr><label class="st-menu-check"><input type="checkbox" data-k="agentConfirm"' + (askBeforeRisky() ? ' checked' : '') + '><span>Спрашивать перед удалением, закрытием и сбросом</span></label>'
      + '<label class="st-menu-check"><input type="checkbox" data-k="agentLook"' + (store.get('agentLook', true) ? ' checked' : '') + '><span>Смотреть на результат после каждой серии шагов (если включён «глаз»)</span></label>';
    menu.querySelectorAll('[data-steps]').forEach((b) => { b.onclick = () => { store.set('agentSteps', Number(b.dataset.steps)); renderAgentMenu(); }; });
    menu.querySelectorAll('input[data-k]').forEach((c) => { c.onchange = () => store.set(c.dataset.k, c.checked); });
  }
  function toggleAgentMenu(open) {
    const menu = $('agentMenu');
    if (!menu) return;
    const show = open == null ? menu.hidden : open;
    if (show) renderAgentMenu();
    menu.hidden = !show;
    $('agentBtn').setAttribute('aria-expanded', String(show));
  }
  function initAgentMenu() {
    const btn = $('agentBtn');
    if (!btn) return;
    btn.onclick = (e) => { e.stopPropagation(); toggleAgentMenu(); };
    document.addEventListener('pointerdown', (e) => {
      const menu = $('agentMenu');
      if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) toggleAgentMenu(false);
    }, true);
  }
  let allowAllThisTurn = false;
  let autoAllowNoted = false;
  function confirmAction(text) {
    if (!askBeforeRisky() || allowAllThisTurn) {
      if (!autoAllowNoted) {
        autoAllowNoted = true;
        msg('note', 'Необратимые действия выполняю без вопроса — так выбрано. Вернуть вопросы: «Настройки» внизу панели. Отменить шаг — Ctrl+Z.');
      }
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const d = document.createElement('div');
      d.className = 'st-confirm st-raised';
      d.innerHTML = `<p>${esc(text)}</p>`
        + '<label class="st-confirm-check"><input type="checkbox"> Больше не спрашивать (вернуть — «Настройки» внизу панели)</label>'
        + '<div class="st-row"><button class="st-mini danger" data-a="no">Не надо</button>'
        + '<button class="st-mini" data-a="all" title="Не спрашивать до конца этой просьбы">Разрешать всё в этой задаче</button>'
        + '<button class="st-mini" data-a="yes">Разрешить</button></div>';
      add(d);
      d.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          const yes = b.dataset.a !== 'no';
          if (yes && d.querySelector('input').checked) store.set('agentConfirm', false);
          if (b.dataset.a === 'all') allowAllThisTurn = true;
          d.remove();
          resolve(yes);
        };
      });
    });
  }

  function showEmpty() {
    log.innerHTML = `<div class="st-empty">
      <h3>Чем помочь?</h3>
      <p>Спросите, где найти функцию в AI-Audition, или попросите обработать запись за вас: убрать паузы, выровнять громкость, поставить эффекты и маркеры.</p>
      <button class="st-mini primary st-start-tpl">Быстрые задачи</button>
      <div class="st-chips">
        <button class="st-chip" data-act="1">Подготовь голосовую дорожку к подкасту: срез низов, компрессор, де-эссер и лимитер на мастере</button>
        <button class="st-chip" data-act="1">Убери паузы длиннее секунды на дорожке с голосом</button>
        <button class="st-chip" data-act="1">Поставь плавные фейды 20 мс в начале и в конце каждого клипа</button>
        <button class="st-chip">Разбери проект: что на дорожках и что стоит улучшить в звуке?</button>
        <button class="st-chip">Как записать голос и какие уровни выставить для подкаста?</button>
      </div></div>`;
    const st = log.querySelector('.st-start-tpl');
    if (st) st.onclick = () => Gallery.show(true);
    log.querySelectorAll('.st-chip').forEach((c) => {
      c.onclick = () => {
        if (c.dataset.act) setMode('act');
        input.value = c.textContent;
        if (/:\s*$/.test(c.textContent)) { autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); return; }
        send();
      };
    });
  }

  // ------------------------------------------------------------------ инструменты для модели
  async function commandById(id) {
    const c = (await commands()).find((x) => x.id === id);
    if (!c) throw new Error(`Нет команды «${id}». Найди нужную через find_commands.`);
    if (DENY.test(id)) throw new Error('Эту команду помощнику выполнять нельзя (файлы, интерфейс и служебное делает панель или сам пользователь).');
    return c;
  }
  const short = (v) => (v === undefined || v === null ? { ok: true } : { ok: true, result: v });
  const trimJson = (v, n) => JSON.parse(clip(JSON.stringify(v), n).replace(/…\[обрезано\]$/, '') || 'null');

  // Выделение отрезка в секундах: дорожки по именам или id, без них — все.
  async function selectTime(a) {
    const d = await session();
    const sr = Number(d.sample_rate) || 48000;
    const all = d.tracks || [];
    if (!all.length) throw new Error('В проекте нет дорожек');
    let tracks = all.map((t) => t.id);
    if (Array.isArray(a.tracks) && a.tracks.length) {
      tracks = a.tracks.map((ref) => {
        const key = String(ref).trim();
        const t = all.find((x) => String(x.id) === key) || all.find((x) => norm(x.name) === norm(key));
        if (!t) throw new Error(`Нет дорожки «${key}». Имена — в get_state.`);
        return t.id;
      });
    }
    const len = Number(d.length_samples) || 0;
    const at = (v, dflt) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v) * sr)) : dflt);
    const start = at(a.start, 0);
    const end = at(a.end, len);
    if (!(end > start)) throw new Error('Конец отрезка должен быть позже начала');
    await PC.exec('edit.select', { tracks, start, end });
    return { ok: true, tracks: tracks.length, start: secs(start, sr), end: secs(end, sr) };
  }

  // Команды, которые только смотрят или выделяют: их не нужно отменять кнопкой.
  const NOT_UNDOABLE = /^(edit\.(select|select_all|select_none|restore_last_selection|mode)|markers\.(recall|next|previous)|engine\.|session\.(inspect|format_time|audio_health)|track\.inspect|clip\.inspect|midi\.notes|transport\.|view\.|zoom|file\.bounce)/;
  async function runTool(name, args) {
    if (mode !== 'act' && !READ_TOOLS.has(name)) {
      return { ok: false, error: 'Сейчас режим «Совет»: действия выключены. Объясни пользователю, как сделать это самому, или предложи переключиться в «Сделай».' };
    }
    switch (name) {
      case 'find_commands': {
        const d = card(name, args);
        const r = await findCommands(String(args.query || ''));
        cardResult(d, true);
        return r;
      }
      case 'get_state': {
        card(name, args);
        return await snapshot();
      }
      case 'track_details': {
        const d = card(name, args);
        try { const r = await trackDetails(args.track ?? args.id ?? args.name); cardResult(d, true); return short(trimJson(r, 8000)); } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'look_at_screen': {
        const d = card(name, args);
        const img = await screenshot();
        cardResult(d, !!img, 'Снимок не получился');
        return img ? { ok: true, note: 'Снимок приложен следующим сообщением.', __image: img } : { ok: false, error: 'Снимок экрана не получился' };
      }
      case 'run_command': {
        const c = await commandById(String(args.id || ''));
        if (CONFIRM.test(c.id) && !(await confirmAction(`Помощник хочет выполнить «${ruPath(c)}». Разрешить?`))) {
          card(name, args, ['Пропущено пользователем', ruPath(c)]).classList.add('fail');
          return { ok: false, error: 'Пользователь не разрешил это действие. Не повторяй его, спроси, как поступить.' };
        }
        const d = card(name, args, ['Выполняю', ruPath(c)]);
        root.classList.add('acting');
        try {
          const r = await PC.exec(c.id, args.params && typeof args.params === 'object' ? args.params : null);
          cardResult(d, true, '', !NOT_UNDOABLE.test(c.id));
          return short(r && typeof r === 'object' ? trimJson(r, 3000) : r);
        } catch (e) {
          cardResult(d, false, e.message);
          return { ok: false, error: e.message, params_doc: c.params ? clip(String(c.params), 800) : undefined };
        } finally {
          root.classList.remove('acting');
        }
      }
      case 'select_time': {
        const d = card(name, args);
        try { const r = await selectTime(args); cardResult(d, true); return r; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'undo': {
        const n = Math.max(1, Math.min(20, parseInt(args.steps, 10) || 1));
        const d = card(name, { steps: n });
        try { for (let i = 0; i < n; i++) await PC.exec('edit.undo'); cardResult(d, true); return { ok: true }; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      default:
        return { ok: false, error: `Инструмента «${name}» нет. Доступны только: ${TOOL_NAMES.join(', ')}. Кликов по координатам нет: найди команду через find_commands и выполни её run_command.` };
    }
  }

  // Модель иногда пишет вызов инструмента текстом вместо tool_calls — подхватываем его.
  const TOOL_NAMES = ['find_commands', 'get_state', 'track_details', 'look_at_screen', 'run_command', 'select_time', 'undo'];
  function inlineCalls(text) {
    if (!text || !/[{[]/.test(text)) return [];
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      const o = JSON.parse(m[0]);
      const list = Array.isArray(o) ? o : [o];
      return list
        .filter((x) => x && TOOL_NAMES.includes(x.name))
        .map((x) => ({ function: { name: x.name, arguments: x.arguments || x.parameters || {} } }));
    } catch { return []; }
  }


  // ------------------------------------------------------------------ разговор с моделью
  // Память разговора. У модели ограниченный контекст (CTX токенов, сервер сообщает его при запуске);
  // если история не влезает, сервер модели молча отрезает её начало — вместе с задачей, и помощник
  // начинает ходить по кругу. Поэтому прошлые просьбы уходят сжато (просьба и итог, без шагов и
  // снимков), текущая — целиком; если и она не влезает, сначала сокращаются старые результаты шагов,
  // потом выпадают самые ранние шаги, но сама просьба остаётся всегда.
  let CTX = 32768;
  let turnStart = 0;
  const AUTO_STATE = /\n\n\[Состояние [^\]]*— автоматически\][\s\S]*$/;
  const AUTO_MSG = /^\[(Снимок экрана|Состояние)[^\]]*автоматически\]/;
  const plainText = (t) => String(t || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<?function=[\w.-]+>[\s\S]*?(<\/function>|$)/g, '').replace(/<\/?tool_call>/g, '').trim();
  const sizeOf = (m) => String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + (m.images ? m.images.length * 3500 : 0);
  function outgoing() {
    const start = Math.min(Math.max(0, turnStart), convo.length);
    const older = [];
    for (const m of convo.slice(0, start)) {
      if (m.role === 'tool') continue;
      if (m.role === 'user') {
        if (AUTO_MSG.test(String(m.content || ''))) continue;
        older.push({ role: 'user', content: clip(String(m.content || '').replace(AUTO_STATE, ''), 1500) });
      } else if (m.role === 'assistant') {
        const text = plainText(m.content);
        const names = [...new Set((m.tool_calls || []).map((c) => c.function && c.function.name).filter(Boolean))];
        const line = text ? clip(text, 1200) : (names.length ? '[Выполнено: ' + names.join(', ') + ']' : '');
        if (!line) continue;
        const last = older[older.length - 1];
        if (last && last.role === 'assistant') last.content = clip(last.content + '\n' + line, 2400);
        else older.push({ role: 'assistant', content: line });
      }
    }
    const recent = older.slice(-16);
    while (recent.length && recent[0].role !== 'user') recent.shift();
    const out = recent.concat(convo.slice(start).map((m) => ({ ...m })));
    // Только последний снимок экрана: картинки тяжёлые.
    let images = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].images) continue;
      if (images >= 1) delete out[i].images; else images += out[i].images.length;
    }
    const budget = Math.max(12000, Math.round(CTX * 2.6) - 22000);
    let total = out.reduce((n, m) => n + sizeOf(m), 0);
    let task = out.length - (convo.length - start); // где в out начинается текущая просьба
    // 1) прошлые просьбы, начиная с самых старых
    while (total > budget && task > 0) {
      total -= sizeOf(out.shift());
      task--;
      while (task > 0 && out[0].role !== 'user') { total -= sizeOf(out.shift()); task--; }
    }
    // 2) старые результаты шагов и устаревшие состояния текущей просьбы
    for (let i = task + 1; total > budget && i < out.length - 6; i++) {
      const m = out[i];
      if ((m.role === 'tool' || AUTO_MSG.test(String(m.content || ''))) && String(m.content || '').length > 400) {
        total -= sizeOf(m);
        m.content = clip(String(m.content), 300);
        delete m.images;
        total += sizeOf(m);
      }
    }
    // 3) самые ранние шаги текущей просьбы (целыми группами: ответ модели и результаты его шагов)
    let dropped = 0;
    while (total > budget && out.length - (task + 1) > 8) {
      let end = task + 2;
      while (end < out.length - 8 && out[end].role !== 'assistant') end++;
      const removed = out.splice(task + 1, end - (task + 1));
      if (!removed.length) break;
      dropped += removed.length;
      total -= removed.reduce((n, m) => n + sizeOf(m), 0);
    }
    if (dropped) {
      out.splice(task + 1, 0, { role: 'user', content: `[Ранние шаги этой просьбы (${dropped} сообщ.) убраны, чтобы уместиться в память модели. Что уже сделано — смотри по последнему состоянию.]` });
      if (out[task + 2] && out[task + 2].role === 'tool') out.splice(task + 2, 0, { role: 'assistant', content: '[продолжаю]' });
    }
    return out;
  }

  // Запрос к серверу помощника. Если сервер не принимает запрос со снимком экрана (nginx по
  // умолчанию берёт не больше 1 МБ и при большем просто обрывает соединение — браузер пишет
  // «Failed to fetch»), запрос повторяется без снимка, и дальше снимки не отправляются.
  const BODY_LIMIT = 900 * 1024;
  let imagesBlocked = false;
  const withoutImages = (payload) => ({ ...payload, messages: payload.messages.map((m) => { const { images, ...rest } = m; void images; return rest; }) });
  const hasImages = (payload) => payload.messages.some((m) => m.images && m.images.length);
  function tellImagesBlocked() {
    if (imagesBlocked) return;
    imagesBlocked = true;
    msg('note', 'Сервер не принял запрос со снимком экрана, поэтому помощник отвечает без него. ' +
      'Чтобы он видел экран, добавьте в nginx для api/assistant.php строку <code>client_max_body_size 20m;</code> (готовый блок — в nginx.conf.example).');
  }
  async function explainNoAnswer(seconds) {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const when = seconds >= 1 ? ` через ${Math.round(seconds)} с` : ' сразу';
        const why = seconds >= 45
          ? 'Похоже, сервер не дождался модели: для api/assistant.php нужна строка fastcgi_read_timeout 200s; (и такой же таймаут у прокси перед сервером, если он есть).'
          : 'Обычно так бывает, когда запрос больше, чем разрешает сервер (client_max_body_size 20m; для api/assistant.php), или его блокирует защита сервера.';
        return `Сервер оборвал соединение${when} и ничего не ответил, хотя сам помощник доступен. ${why} Готовый блок — в nginx.conf.example.`;
      }
      return `Сервер помощника ответил «${r.status}». Проверьте, что PHP обрабатывает файлы в папке api/.`;
    } catch {
      return 'Нет связи с сервером помощника: страница не может достучаться до api/assistant.php. Проверьте подключение и обновите страницу.';
    }
  }
  async function postApi(payload) {
    const post = (p) => fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    if (imagesBlocked && hasImages(payload)) payload = withoutImages(payload);
    if (hasImages(payload) && JSON.stringify(payload).length > BODY_LIMIT) payload = withoutImages(payload);
    let r;
    const t0 = performance.now();
    const took = () => (performance.now() - t0) / 1000;
    try {
      r = await post(payload);
    } catch (e) {
      console.warn('AI-Audition: запрос к помощнику оборвался', e);
      if (!hasImages(payload)) throw new Error(await explainNoAnswer(took()));
      try { r = await post(withoutImages(payload)); } catch { throw new Error(await explainNoAnswer(took())); }
      tellImagesBlocked();
      return r;
    }
    if (r.status === 413 && hasImages(payload)) {
      r = await post(withoutImages(payload));
      tellImagesBlocked();
    }
    return r;
  }
  async function readAnswer(r) {
    let j;
    try { j = await r.json(); } catch {
      if (r.status === 413) throw new Error('Сервер не принял такой большой запрос (413). Нужна строка client_max_body_size 20m; в nginx — см. nginx.conf.example.');
      if (r.status === 502 || r.status === 504) throw new Error(`Сервер не дождался ответа модели (${r.status}). Нужна строка fastcgi_read_timeout 200s; в nginx — см. nginx.conf.example.`);
      throw new Error(`Сервер помощника ответил не JSON (HTTP ${r.status}). Проверьте, что PHP работает в папке api/.`);
    }
    return j;
  }
  // Шлюз модели не передаёт инструменты штатно (вызовы приходят текстом) — запоминаем это.
  let textTools = store.get('textTools', false);
  async function ask() {
    const r = await postApi({ mode, messages: outgoing(), textTools });
    const j = await readAnswer(r);
    if (j && j.ok && j.textTools && !textTools) { textTools = true; store.set('textTools', true); }
    if (!j.ok) {
      const e = new Error(j.error || 'Ошибка помощника');
      e.noVision = !!j.noVision;
      throw e;
    }
    return j;
  }

  async function send(fromBar) {
    if (busy) { stopRequested = true; return; }
    const field = typeof fromBar === 'string' ? null : input;
    const text = (typeof fromBar === 'string' ? fromBar : input.value).trim();
    if (!text) return;
    if (field) { field.value = ''; autosize(); }
    setBusy(true);
    stopRequested = false;
    allowAllThisTurn = false;
    autoAllowNoted = false;
    seen = new Map();
    msg('user', esc(text));
    try {
      let state = null;
      let image = null;
      if (PC.ready()) {
        state = await snapshot().catch((e) => ({ error: e.message }));
        if (attachScreen) image = await screenshot();
      }
      turnStart = convo.length;
      convo.push({
        role: 'user',
        content: MODE_TAG[mode] + '\n' + text + '\n\n[Состояние редактора — автоматически]\n' + clip(JSON.stringify(state ?? { note: 'Редактор ещё загружается' }), 4000),
        ...(image ? { images: [image] } : {}),
      });
      await runSteps();
    } catch (e) {
      turnFailed(e);
    } finally {
      turnDone();
    }
  }
  // Продолжить ту же просьбу после остановки по числу шагов (без нового сообщения).
  async function continueTurn() {
    if (busy) return;
    setBusy(true);
    stopRequested = false;
    try { await runSteps(); } catch (e) { turnFailed(e); } finally { turnDone(); }
  }
  function turnFailed(e) {
    typing(false);
    if (e.noVision) setEye(false);
    msg('err', esc(e.message || String(e)));
  }
  function turnDone() {
    typing(false);
    setBusy(false);
    root.classList.remove('acting');
    updateBarAnswer();
  }
  // Повторы считаются за всю просьбу, в том числе после «Продолжить».
  let seen = new Map();
  async function runSteps() {
    const limit = agentSteps();
    for (let step = 0; ; step++) {
      if (stopRequested) { msg('bot', 'Остановлено.'); break; }
      if (step >= limit) {
        const d = msg('note', `Сделал ${limit} шагов подряд и остановился (так задано: «Настройки» внизу панели). `);
        const b = document.createElement('button');
        b.className = 'st-mini';
        b.textContent = 'Продолжить';
        b.onclick = () => { b.disabled = true; continueTurn(); };
        d.appendChild(b);
        break;
      }
      typing(true);
      const j = await ask();
      typing(false);
        const m = j.message || {};
        let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        let content = (m.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<?function=[\w.-]+>[\s\S]*?(<\/function>|$)/g, '').replace(/<\/?tool_call>/g, '').trim();
        if (!calls.length) {
          calls = inlineCalls(content);
          if (calls.length) content = content.replace(/\{[\s\S]*\}/, '').trim();
        }
        // «Сделай», а модель всё равно ответила как в «Совете» — одна попытка её поправить.
        if (mode === 'act' && !calls.length && step === 0 && /режим\S*\s*«?Совет/i.test(content)) {
          convo.push({ role: 'assistant', content: m.content || '' });
          convo.push({ role: 'user', content: MODE_NOTE.act + ' Выполни просьбу сейчас.' });
          continue;
        }
        convo.push({ role: 'assistant', content: m.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (content) msg('bot', format(content));
        if (!calls.length) break;
        let pendingImage = null;
        let acted = false;
        for (const c of calls) {
          if (stopRequested) break;
          const fname = c.function && c.function.name;
          let a = (c.function && c.function.arguments) || {};
          if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch { a = {}; } }
          const sig = fname + ' ' + JSON.stringify(a || {});
          const times = (seen.get(sig) || 0) + 1;
          seen.set(sig, times);
          let result;
          try { result = await runTool(fname, a || {}); } catch (e) { result = { ok: false, error: e.message || String(e) }; }
          if (result && result.__image) { pendingImage = result.__image; delete result.__image; }
          const reading = READ_TOOLS.has(fname);
          if (!reading) acted = true;
          // Одно и то же действие по кругу — подсказываем модели остановиться и проверить результат.
          if (times >= (reading ? 4 : 3)) {
            const warning = `Ты уже ${times} раз(а) вызывал ${fname} с теми же параметрами. Не повторяй. `
              + (reading ? 'Всё нужное уже получено — действуй или заверши ответ.' : 'Проверь результат (get_state или look_at_screen) и переходи к следующей части задачи; если задача выполнена — заверши её коротким итогом.');
            result = (result && typeof result === 'object' && !Array.isArray(result)) ? { ...result, warning } : { result, warning };
          }
          convo.push({ role: 'tool', tool_name: fname, content: clip(JSON.stringify(result ?? { ok: true }), 6000) });
        }
        // После действий — свежее состояние документа (и снимок, если помощнику можно смотреть
        // на экран): модель видит, что уже сделано, и не рисует одно и то же заново.
        if (acted && !stopRequested && PC.ready()) {
          const st = await snapshot().catch(() => null);
          if (!pendingImage && attachScreen && store.get('agentLook', true)) pendingImage = await screenshot().catch(() => null);
          convo.push({
            role: 'user',
            content: '[Состояние после этих шагов — автоматически]\n' + clip(JSON.stringify(st ?? {}), 3500) + (pendingImage ? '\n(снимок экрана приложен)' : ''),
            ...(pendingImage ? { images: [pendingImage] } : {}),
          });
        } else if (pendingImage) {
          convo.push({ role: 'user', content: '[Снимок экрана после действий — прислан автоматически]', images: [pendingImage] });
        }
    }
  }

  // ------------------------------------------------------------------ быстрая строка
  // Ctrl+Shift+Пробел: поле внизу над холстом. Ответ всплывает над ним; вся история — в панели.
  const bar = $('bar');
  const barInput = $('barInput');
  const barAnswer = $('barAnswer');
  function setBar(open) {
    root.classList.toggle('bar-open', open);
    if (open) { setTimeout(() => barInput.focus(), 30); updateBarAnswer(); }
  }
  function updateBarAnswer() {
    if (!root.classList.contains('bar-open')) return;
    if (busy) { barAnswer.innerHTML = '<div class="st-typing"><i></i><i></i><i></i></div>'; barAnswer.hidden = false; return; }
    const last = [...log.querySelectorAll('.st-msg.bot, .st-msg.err')].pop();
    if (!last || !barSent) { barAnswer.hidden = true; return; }
    barAnswer.hidden = false;
    barAnswer.innerHTML = `<div class="st-bar-text ${last.classList.contains('err') ? 'err' : ''}">${last.innerHTML}</div><button class="st-link" data-a="panel">Открыть в панели</button>`;
    barAnswer.querySelector('[data-a="panel"]').onclick = () => { setBar(false); setOpen(true); };
  }
  let barSent = false;
  async function sendFromBar() {
    const text = barInput.value.trim();
    if (!text || busy) return;
    barInput.value = '';
    barSent = true;
    const done = send(text);
    updateBarAnswer();
    await done;
    updateBarAnswer();
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setBar(!root.classList.contains('bar-open'));
    }
  }, true);

  // ------------------------------------------------------------------ сообщения и перетаскивание
  function setBadge(on) { root.classList.toggle('has-hints', on); }
  function toast(text, error) {
    let t = root.querySelector('.st-toast');
    if (!t) { t = document.createElement('div'); t.className = 'st-toast'; root.appendChild(t); }
    t.textContent = text;
    t.classList.toggle('err', !!error);
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Файлы, брошенные на страницу, редактор принимает сам. Брошенные на панель помощника или край
  // страницы браузер открыл бы вместо редактора — передаём их редактору.
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dropHideTimer = 0;
  function showDrop(on) {
    root.classList.toggle('dropping', on);
    clearTimeout(dropHideTimer);
    if (on) dropHideTimer = setTimeout(() => root.classList.remove('dropping'), 400);
  }
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById('soundcraft_canvas');
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    showDrop(true);
  });
  window.addEventListener('drop', async (e) => {
    showDrop(false);
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById('soundcraft_canvas');
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (!f || !PC.ready()) return;
    try { toast('Открываю ' + f.name); await VC().open(f.name, new Uint8Array(await f.arrayBuffer())); Files.forget(); }
    catch (err) { toast('Не удалось открыть ' + f.name + ': ' + (err.message || err), true); }
  });

  // ------------------------------------------------------------------ файлы на сервере
  const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
  const fmtDate = (t) => {
    if (!t) return '';
    const d = new Date(t * 1000), now = new Date();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'сегодня, ' + time;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + time;
  };
  // Проект: .scraftz — родной формат (проект и весь его звук одним файлом), .scraft — проект без звука.
  const PROJECT_EXT = /\.(scraftz|scraft)$/i;
  const AUDIO_EXT = /\.(wav|wave|bwf|rf64|aif|aiff|aifc|flac|mp3|mp2|ogg|oga|opus|m4a|m4b|mp4|aac|ac3|caf|mka|webm)$/i;
  const MIDI_EXT = /\.(mid|midi)$/i;
  const ANY_EXT = /\.(scraftz|scraft|wav|wave|bwf|rf64|aif|aiff|aifc|flac|mp3|mp2|ogg|oga|opus|m4a|m4b|mp4|aac|ac3|caf|mka|webm|mid|midi)$/i;
  const NATIVE = '.scraftz';
  const ACCEPT = '.scraftz,.scraft,.wav,.bwf,.rf64,.aif,.aiff,.flac,.mp3,.ogg,.oga,.opus,.m4a,.mp4,.aac,.ac3,.caf,.mka,.webm,.mid,.midi';
  // Имя проекта так, как его запишет редактор (только буквы, цифры, пробел, - _ .; не длиннее 100).
  const engineName = (n) => {
    const s = String(n || '').replace(PROJECT_EXT, '').replace(/[^\p{L}\p{N}\-_ .]/gu, '_').trim().replace(/^\.+/, '');
    return (s ? [...s].slice(0, 100).join('') : 'untitled') + NATIVE;
  };
  // Новый пустой проект (с вопросом, если в открытом есть несохранённые изменения).
  async function newProject() {
    try { const d = await session(); if (d.dirty && !window.confirm('В открытом проекте есть несохранённые изменения. Начать новый проект без них?')) return false; } catch { /* ниже */ }
    await PC.exec('session.new', { name: 'Без названия' });
    return true;
  }

  // Окно с одним полем: имя файла.
  function askName(title, value, note) {
    return new Promise((resolve) => {
      const box = $('ask');
      $('askTitle').textContent = title;
      $('askNote').textContent = note || '';
      const field = $('askInput');
      field.value = value || '';
      box.hidden = false;
      setTimeout(() => { field.focus(); const dot = field.value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : field.value.length); }, 30);
      const done = (v) => { box.hidden = true; form.onsubmit = null; $('askCancel').onclick = null; box.onkeydown = null; resolve(v); };
      const form = box.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); done(field.value.trim() || null); };
      $('askCancel').onclick = () => done(null);
      box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    });
  }

  // Копия в браузере, если сохранить на сервер не вышло (нет связи, сервер не принял файл).
  const Recovery = (() => {
    const open = () => new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('нет IndexedDB')); return; }
      const r = indexedDB.open('aiaudition', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recovery');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('recovery', mode);
        const req = fn(tx.objectStore('recovery'));
        tx.oncomplete = () => { db.close(); resolve(req && req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    };
    return {
      put: (v) => run('readwrite', (s) => s.put(v, 'last')).catch(() => {}),
      get: () => run('readonly', (s) => s.get('last')).catch(() => null),
      clear: () => run('readwrite', (s) => s.delete('last')).catch(() => {}),
    };
  })();

  const Files = (() => {
    let list = [];
    let server = null;        // имя открытого проекта на сервере (с расширением), если он оттуда
    const known = new Set();  // имена проектов на сервере, открытые или сохранённые здесь
    const alias = new Map();  // имя проекта в редакторе → имя на сервере (после переименования)
    let dirty = false;
    let quietNext = false;    // автосохранение
    let saving = false;
    const api = (q) => CFG.files + (q ? '?' + q : '');
    async function json(r) {
      let j = null;
      try { j = await r.json(); } catch { /* ниже */ }
      if (!j) throw new Error(r.status === 413 ? 'Файл слишком большой для сервера: увеличьте client_max_body_size в nginx, post_max_size в PHP и AI_AUDITION_MAX_MB (см. README.ru.md).' : `Сервер ответил ${r.status}: проверьте, что PHP обрабатывает api/files.php.`);
      if (!j.ok) { const e = new Error(j.error || 'Ошибка сервера'); e.exists = !!j.exists; e.login = !!j.login; throw e; }
      return j;
    }
    let limit = 0;
    async function refresh() {
      const j = await json(await fetch(api(''), { credentials: 'same-origin', cache: 'no-store' }));
      list = Array.isArray(j.files) ? j.files : [];
      limit = Number(j.limit) || 0;
      $('filesWho').textContent = j.user && j.user !== 'local' ? 'на сервере · пользователь ' + j.user : 'на сервере';
      return list;
    }
    const serverName = (enginePath) => alias.get(enginePath) || enginePath;
    function render() {
      const q = norm($('filesSearch').value).trim();
      const rows = list.filter((f) => !q || norm(f.name).includes(q));
      const box = $('filesList');
      if (!list.length) { box.innerHTML = '<p class="st-files-empty">Здесь будут ваши проекты и записи. Сохраните открытый проект кнопкой «Сохранить» или Ctrl+S — он ляжет сюда одним файлом .scraftz вместе со всем звуком. Звук (WAV, MP3, FLAC, OGG, M4A…) можно загрузить кнопкой «С компьютера…».</p>'; return; }
      if (!rows.length) { box.innerHTML = '<p class="st-files-empty">Ничего не найдено.</p>'; return; }
      box.innerHTML = rows.map((f, i) => `<div class="st-file" data-i="${i}" tabindex="0">
          <span class="st-file-icon">${ICON.file}</span>
          <span class="st-file-name">${esc(f.name)}</span>
          <span class="st-file-meta">${PROJECT_EXT.test(f.name) ? 'проект' : (MIDI_EXT.test(f.name) ? 'MIDI' : 'звук')} · ${esc(fmtDate(f.modified))} · ${esc(fmtSize(f.size))}</span>
          <span class="st-file-acts"><button class="st-link" data-a="rename">Переименовать</button><button class="st-link danger" data-a="delete">Удалить</button></span>
        </div>`).join('');
      box.querySelectorAll('.st-file').forEach((row) => {
        const f = rows[+row.dataset.i];
        row.onclick = (e) => { if (!e.target.closest('button')) load(f.name); };
        row.onkeydown = (e) => { if (e.key === 'Enter') load(f.name); };
        row.querySelector('[data-a="rename"]').onclick = () => rename(f.name);
        row.querySelector('[data-a="delete"]').onclick = () => remove(f.name);
      });
    }
    function updateFoot() {
      $('filesCurrent').textContent = server ? `Открыт «${server}»` + (dirty ? ' · есть изменения' : '') : (dirty ? 'Проект ещё не сохранён на сервере' : '');
    }
    async function show(on = true) {
      $('files').hidden = !on;
      if (!on) return;
      $('filesList').innerHTML = '<p class="st-files-empty">Загружаю список…</p>';
      updateFoot();
      try { await refresh(); render(); } catch (e) { $('filesList').innerHTML = `<p class="st-files-empty err">${esc(e.message)}</p>`; }
      setTimeout(() => $('filesSearch').focus(), 30);
    }
    // Проект открывается вместо текущего (редактор сам спросит про несохранённые изменения);
    // звук и MIDI ложатся в открытый проект новыми дорожками.
    async function load(name) {
      try {
        toast('Открываю «' + name + '»…');
        const r = await fetch(api('action=load&name=' + encodeURIComponent(name)), { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) await json(r);
        const bytes = new Uint8Array(await r.arrayBuffer());
        await VC().open(name, bytes);
        show(false);
        if (!PROJECT_EXT.test(name)) { toast(`«${name}» добавлен в проект новой дорожкой. Отменить — Ctrl+Z.`); return; }
        // Проект открывается на следующем кадре (или после ответа на вопрос о несохранённом).
        const expect = engineName(name);
        for (let i = 0; i < 600; i++) {
          const d = await session().catch(() => null);
          if (d && d.path === expect) break;
          await sleep(100);
        }
        known.add(expect);
        if (expect !== name) alias.set(expect, name);
        server = name;
      } catch (e) { toast('Не удалось открыть: ' + e.message, true); }
    }
    async function upload(name, bytes, overwrite) {
      const r = await fetch(api('action=save&name=' + encodeURIComponent(name) + (overwrite ? '&overwrite=1' : '')), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      });
      return json(r);
    }
    // Сохранение из редактора (Ctrl+S, Файл › Сохранить, «Сохранить как»): проект приходит сюда
    // одним файлом .scraftz под тем именем, которое дал ему редактор.
    async function onSave(detail) {
      const quiet = quietNext;
      quietNext = false;
      const bytes = detail.bytes;
      const path = String(detail.path || detail.name || '');
      const name = serverName(path) || engineName('Проект');
      try {
        saving = true;
        let overwrite = known.has(path) || name === server;
        if (!overwrite) {
          if (!list.length) await refresh().catch(() => {});
          if (list.some((f) => f.name === name) && !window.confirm(`Проект «${name}» уже есть в «Моих проектах». Заменить его?`)) { dirty = true; return; }
          overwrite = true;
        }
        if (limit && bytes.length > limit) throw new Error(`проект (${fmtSize(bytes.length)}) больше предела сервера ${fmtSize(limit)}`);
        const r = await upload(name, bytes, overwrite);
        server = r.name;
        known.add(path);
        if (path !== r.name) alias.set(path, r.name);
        Recovery.clear();
        if (!quiet) toast('Сохранено в «Мои проекты»: «' + r.name + '»');
        if (!$('files').hidden) { await refresh().catch(() => {}); render(); updateFoot(); }
      } catch (e) {
        Recovery.put({ name, data: bytes, time: Date.now() });
        if (e.login) toast('Войдите в систему, чтобы сохранять проекты на сервере. Копия осталась в браузере.', true);
        else toast((quiet ? 'Автосохранение не удалось: ' : 'Не удалось сохранить: ') + e.message + '. Копия осталась в браузере.', true);
      } finally { saving = false; }
    }
    async function save(saveAs) {
      if (!PC.ready()) return;
      try {
        const d = await session();
        if (!saveAs && d.path && (known.has(d.path) || serverName(d.path) === server)) { await PC.exec('session.save'); return; }
        const suggest = d.path ? serverName(d.path) : engineName(d.name || 'Проект');
        const typed = await askName(saveAs ? 'Сохранить как' : 'Сохранить на сервере', suggest, 'Проект со всем звуком ляжет в «Мои проекты» одним файлом .scraftz.');
        if (!typed) return;
        await PC.exec('session.save_as', { path: engineName(typed) });
      } catch (e) { toast('Не удалось сохранить: ' + e.message, true); }
    }
    async function rename(name) {
      const to0 = await askName('Переименовать', name);
      if (!to0 || to0 === name) return;
      const ext = (name.match(ANY_EXT) || [''])[0];
      const to = ANY_EXT.test(to0) ? to0 : to0 + ext;
      try {
        await json(await fetch(api('action=rename'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, to }) }));
        for (const [p, n] of [...alias.entries()]) if (n === name) alias.set(p, to);
        if (known.has(name) && !alias.has(name)) alias.set(name, to);
        if (server === name) server = to;
        await refresh(); render(); updateFoot();
      } catch (e) { toast('Не удалось переименовать: ' + e.message, true); }
    }
    async function remove(name) {
      if (!window.confirm(`Удалить «${name}»? Файл уйдёт в корзину на сервере.`)) return;
      try {
        await json(await fetch(api('action=delete'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }));
        if (server === name) server = null;
        await refresh(); render();
      } catch (e) { toast('Не удалось удалить: ' + e.message, true); }
    }
    // Файл с компьютера: проект открывается, звук и MIDI — новыми дорожками. Звук сразу кладём и
    // в «Мои проекты», чтобы запись была на сервере (если сервер его принимает).
    function pickLocal(audioOnly) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = audioOnly ? ACCEPT.replace('.scraftz,.scraft,', '') : ACCEPT;
      input.multiple = !!audioOnly;
      input.onchange = async () => {
        for (const f of input.files || []) {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            await VC().open(f.name, bytes);
            show(false);
            if (PROJECT_EXT.test(f.name)) { server = null; toast('Открыт «' + f.name + '». Сохраните его (Ctrl+S), чтобы он появился в «Моих проектах».'); continue; }
            toast('«' + f.name + '» добавлен новой дорожкой. Отменить — Ctrl+Z.');
            if (ANY_EXT.test(f.name) && (!limit || bytes.length <= limit)) upload(f.name, bytes, false).catch(() => { /* уже есть или не принят — запись всё равно в проекте */ });
          } catch (e) { toast('Не удалось открыть ' + f.name + ': ' + e.message, true); }
        }
      };
      input.click();
    }
    async function offerRecovery() {
      const r = await Recovery.get();
      if (!r || !r.data) return;
      const when = new Date(r.time).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const d = msg('note', `Проект «${esc(r.name)}» от ${esc(when)} не удалось сохранить на сервер — его копия осталась в браузере. ` +
        '<span class="st-row"><button class="st-mini" data-a="open">Открыть копию</button><button class="st-mini danger" data-a="drop">Удалить копию</button></span>');
      d.querySelector('[data-a="open"]').onclick = async () => {
        try { await VC().open(r.name, r.data); server = null; d.remove(); toast('Копия открыта. Сохраните её (Ctrl+S).'); }
        catch (e) { toast('Не удалось открыть копию: ' + e.message, true); }
      };
      d.querySelector('[data-a="drop"]').onclick = () => { Recovery.clear(); d.remove(); };
      setOpen(true);
    }
    // Раз в autosaveSeconds: проект, который уже лежит на сервере, сохраняется туда сам.
    async function tick() {
      for (;;) {
        await sleep(Math.max(30, CFG.autosaveSeconds || 120) * 1000);
        if (!CFG.autosaveSeconds || document.hidden || !PC.ready() || saving || !server || !dirty) continue;
        const d = await session().catch(() => null);
        if (!d || !d.path || !known.has(d.path) || d.transport?.playing || d.transport?.recording) continue;
        quietNext = true;
        await PC.exec('session.save').catch(() => { quietNext = false; });
      }
    }
    function start() {
      VC().takesSaves = true;
      window.addEventListener('aiaudition:save', (e) => onSave(e.detail || {}));
      window.addEventListener('aiaudition:dirty', (e) => { dirty = !!(e.detail && e.detail.dirty); if (!$('files').hidden) updateFoot(); });
      $('filesBtn').onclick = () => show(true);
      $('filesClose').onclick = () => show(false);
      $('files').addEventListener('pointerdown', (e) => { if (e.target === $('files')) show(false); });
      $('files').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('ask').hidden) { e.preventDefault(); show(false); } });
      $('filesSearch').addEventListener('input', render);
      $('filesNew').onclick = async () => { try { if (await newProject()) { server = null; show(false); } } catch (e) { toast(e.message, true); } };
      $('filesUpload').onclick = () => pickLocal(false);
      $('filesSave').onclick = () => save(false);
      $('filesSaveAs').onclick = () => save(true);
      // Браузер не должен предлагать «Сохранить страницу как…».
      window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) e.preventDefault(); }, true);
      offerRecovery();
      tick();
      if (CFG.filesOnStart) refresh().then((l) => { if (l.length) show(true); }).catch(() => {});
    }
    return { start, show, save, pickLocal, current: () => server, forget: () => { server = null; }, isServer: (p) => known.has(p) };
  })();

  // ------------------------------------------------------------------ быстрые задачи
  // Дорожки, на которые действует задача: выделенные, а если не выделено ни одной — все аудиодорожки с клипами.
  async function workTracks() {
    const d = await session();
    const audio = (d.tracks || []).filter((t) => t.kind === 'audio' && !t.inactive);
    if (!audio.length) throw new Error('В проекте нет аудиодорожек. Откройте запись из «Моих проектов» или с компьютера.');
    const sel = new Set((d.selection && d.selection.tracks) || []);
    const chosen = audio.filter((t) => sel.has(t.id));
    const tracks = (chosen.length ? chosen : audio).filter((t) => (t.clips || []).length);
    if (!tracks.length) throw new Error('На этих дорожках нет клипов.');
    return { d, tracks, sr: Number(d.sample_rate) || 48000 };
  }
  const audioClips = (tracks) => tracks.flatMap((t) => (t.clips || []).filter((c) => c.source != null).map((c) => c.id));
  const freeSlots = (t) => { const used = new Set((t.inserts || []).map((x) => x.slot)); return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((i) => !used.has(i)); };
  const hasPlugin = (t, id) => (t.inserts || []).some((x) => x.plugin === id);
  let undoSteps = 0;
  const run = async (id, params) => { const r = await PC.exec(id, params || {}); undoSteps++; return r; };

  const TASKS = [
    ['Звук', [
      ['Добавить запись…', 'WAV, MP3, FLAC, OGG, M4A с компьютера — новой дорожкой', async () => { Files.pickLocal(true); return 'skip'; }],
      ['Дорожка для голоса', 'Новая моно-дорожка «Голос»', async () => { await run('track.new', { count: 1, format: 'mono', kind: 'audio', name: 'Голос' }); }],
      ['Маркер здесь', 'В точке вставки, с номером', async () => { await run('markers.add', {}); }],
    ]],
    ['Подкаст и озвучка', [
      ['Убрать тишину', 'Паузы тише −45 дБ длиннее 0,5 с; одну дорожку — сомкнуть', async () => {
        const { d, tracks, sr } = await workTracks();
        const end = Math.max(1, Number(d.length_samples) || 0);
        await PC.exec('edit.select', { tracks: tracks.map((t) => t.id), start: 0, end });
        await run('edit.strip_silence', { threshold_db: -45, min_length_ms: 500, pad_before_ms: 60, pad_after_ms: 150, mode: 'strip' });
        if (tracks.length !== 1) return 'Тишина вырезана. Дорожек несколько, поэтому клипы не сдвигались — синхронность сохранена.';
        const after = await session();
        const t = (after.tracks || []).find((x) => x.id === tracks[0].id);
        const ids = (t && t.clips || []).map((c) => c.id);
        if (ids.length > 1) await run('edit.space_clips', { clips: ids, gap: Math.round(0.3 * sr), mode: 'end_to_start' });
        return 'Тишина вырезана, паузы между фразами — 0,3 с.';
      }],
      ['Выровнять громкость', 'Нормализовать клипы по пику до −1 дБ', async () => {
        const { tracks } = await workTracks();
        const clips = audioClips(tracks);
        if (!clips.length) throw new Error('Нет аудиоклипов.');
        await run('audiosuite.process', { process: 'normalize', params: { target_db: -1 }, clips });
      }],
      ['Подготовить к подкасту', 'Голос: срез НЧ, компрессор, де-эссер; мастер: лимитер −1 дБ', async () => {
        const { d, tracks } = await workTracks();
        for (const t of tracks) {
          const slots = freeSlots(t);
          const chain = [
            ['eq_7band', { hpf_on: 1, hpf_freq: 80 }],
            ['compressor', { threshold: -18, ratio: 3, attack: 10, release: 120, makeup: 4 }],
            ['de_esser', { threshold: -30, range: 6 }],
          ].filter(([id]) => !hasPlugin(t, id));
          for (const [plugin, params] of chain) {
            const slot = slots.shift();
            if (slot == null) break;
            await run('mix.insert', { track: t.id, slot, plugin, params });
          }
        }
        let master = (d.tracks || []).find((t) => t.kind === 'master');
        if (!master) {
          await run('track.new', { count: 1, kind: 'master', format: 'stereo', name: 'Мастер' });
          master = ((await session()).tracks || []).find((t) => t.kind === 'master');
        }
        if (master && !hasPlugin(master, 'maximizer')) {
          const slot = freeSlots(master).shift();
          if (slot != null) await run('mix.insert', { track: master.id, slot, plugin: 'maximizer', params: { threshold: -4, ceiling: -1, release: 50 } });
        }
        return 'Эффекты поставлены (Окно › Микшер). Послушайте и при необходимости подстройте порог компрессора.';
      }],
      ['Плавные края клипов', 'Фейды 10 мс в начале и в конце каждого клипа', async () => {
        const { tracks, sr } = await workTracks();
        const len = Math.max(1, Math.round(0.01 * sr));
        for (const t of tracks) for (const c of t.clips || []) {
          if (c.source == null || c.length <= 4 * len) continue;
          if (!c.fade_in) await run('edit.fades_create', { clip: c.id, side: 'in', length: len, shape: 'equal power' });
          if (!c.fade_out) await run('edit.fades_create', { clip: c.id, side: 'out', length: len, shape: 'equal power' });
        }
      }],
      ['Голос громче на 3 дБ', 'Усиление выбранных клипов (или всех)', async () => {
        const { d, tracks } = await workTracks();
        const sel = (d.selection && d.selection.clips) || [];
        await run('clip.gain', { clips: sel.length ? sel : audioClips(tracks), delta_db: 3 });
      }],
    ]],
    ['Файл', [
      ['Сохранить на сервер', 'Ctrl+S, в «Мои проекты»', async () => { await Files.save(false); return 'skip'; }],
      ['Сохранить как…', 'Под другим именем', async () => { await Files.save(true); return 'skip'; }],
      ['Скачать сведение WAV', '16 бит, весь проект', async () => { const d = await session(); await PC.exec('file.bounce_mix', { path: engineName(d.name).replace(/\.scraftz$/, '.wav'), format: 'wav', bit_depth: 16 }); return 'Сведение готово — смотрите загрузки браузера.'; }],
      ['Скачать сведение MP3', '192 кбит/с, для публикации подкаста', async () => { const d = await session(); await PC.exec('file.bounce_mix', { path: engineName(d.name).replace(/\.scraftz$/, '.mp3'), format: 'mp3', bitrate: 192 }); return 'Сведение готово — смотрите загрузки браузера.'; }],
      ['Скачать сведение FLAC', 'Без потерь, 24 бита', async () => { const d = await session(); await PC.exec('file.bounce_mix', { path: engineName(d.name).replace(/\.scraftz$/, '.flac'), format: 'flac', bit_depth: 24 }); return 'Сведение готово — смотрите загрузки браузера.'; }],
      ['Новый проект', 'Пустой', async () => { if (await newProject()) Files.forget(); return 'skip'; }],
    ]],
    ['Попросить помощника', [
      ['Разобрать проект', 'Что на дорожках, что улучшить', '?Разбери проект: какие дорожки и клипы, какие эффекты стоят, что стоит улучшить в звуке для подкаста.'],
      ['Обработать голос', 'Эквалайзер, компрессор, де-эссер', '!Подготовь голосовые дорожки к подкасту: срез низов, компрессор, де-эссер, а на мастер — лимитер с потолком −1 дБ.'],
      ['Назвать дорожки', 'Понятные имена дорожек и клипов', '!Дай дорожкам и клипам понятные короткие имена по их роли в проекте (ведущий, гость, музыка…), если сейчас у них технические имена.'],
      ['Уровни для подкаста', 'Как получить −16 LUFS', '?Как свести подкаст на −16 LUFS с пиком не выше −1 дБ в этом редакторе? По шагам.'],
      ['Сведение и громкость', 'Свести и проверить LUFS', '!Сведи проект в WAV 16 бит и скажи, какая получилась громкость (LUFS) и пик.'],
    ]],
  ];
  const Gallery = (() => {
    function show(on = true) {
      $('gallery').hidden = !on;
      if (on) renderTasks();
    }
    function renderTasks() {
      $('gTasks').innerHTML = TASKS.map(([group, items], gi) => `<section><h4>${esc(group)}</h4><div>${items.map(([n, d], i) => `<button class="st-task" data-g="${gi}" data-i="${i}"><b>${esc(n)}</b><small>${esc(d)}</small></button>`).join('')}</div></section>`).join('');
      $('gTasks').querySelectorAll('.st-task').forEach((b) => {
        const [, , task] = TASKS[+b.dataset.g][1][+b.dataset.i];
        b.onclick = async () => {
          if (typeof task === 'string') {
            show(false);
            setOpen(true);
            setMode(task.startsWith('?') ? 'advice' : 'act');
            const text = task.replace(/^[!?]/, '');
            input.value = text;
            if (text.endsWith(': ')) { autosize(); input.focus(); input.setSelectionRange(text.length, text.length); }
            else send();
            return;
          }
          b.disabled = true;
          undoSteps = 0;
          try {
            const note = await task();
            show(false);
            if (note !== 'skip') toast((note || 'Готово: ' + b.querySelector('b').textContent + '.') + (undoSteps ? ' Отменить — Ctrl+Z' + (undoSteps > 1 ? ` (${undoSteps} шаг.)` : '') + '.' : ''));
          } catch (e) { toast(e.message, true); }
          finally { b.disabled = false; }
        };
      });
    }
    function start() {
      $('galleryBtn').onclick = () => show(true);
      $('galleryClose').onclick = () => show(false);
      $('gallery').addEventListener('pointerdown', (e) => { if (e.target === $('gallery')) show(false); });
      $('gallery').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); show(false); } });
    }
    return { start, show };
  })();

  // ------------------------------------------------------------------ ИИ у выделения
  // Кнопка «ИИ» в строке меню редактора присылает событие aiaudition:ai; Ctrl+Alt+Пробел открывает то
  // же меню над окном. Текст в звуковом проекте — это названия клипов, дорожек и маркеров и комментарии
  // к дорожкам: с ними и работаем. Выделены клипы — их названия; выделены дорожки — названия дорожек
  // и их комментарии; ничего — маркеры; маркеров нет — проект целиком (для описания выпуска).
  // Модель видит план всего проекта (api/context.php), а результат не попадает в проект сам:
  // его можно применить к названиям, записать в комментарий дорожки или скопировать.
  const AI_MENU = [
    ['Названия', [['names_clear', 'Понятные названия'], ['names_fix', 'Исправить ошибки'], ['names_short', 'Короче'], ['translate_ru', 'На русский'], ['translate_en', 'На английский']]],
    ['Комментарий дорожки', [['comment_write', 'Написать комментарий'], ['comment_improve', 'Улучшить комментарий']]],
    ['Выпуск', [['chapters', 'Главы с таймкодами'], ['description', 'Описание выпуска'], ['titles', 'Варианты названия'], ['summary', 'Что в проекте']]],
  ];
  // Эти операции дают новые названия — по одному на строку, в том же порядке.
  const AI_NAMES = /^(names_|translate_)/;
  const AI_COMMENT = /^comment_/;
  const AI_LABEL = Object.fromEntries(AI_MENU.flatMap((g) => g[1]));

  // Markdown модели → простой HTML: абзацы, подзаголовки, списки, таблицы, полужирный и курсив.
  function mdToHtml(md) {
    const inline = (s) => esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(«])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)»]|$)/g, '$1<i>$2</i>')
      .replace(/`([^`\n]+)`/g, '$1');
    const out = [];
    let list = null;
    let rows = null;
    const close = () => {
      if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; }
      if (rows) {
        const [head, ...body] = rows;
        const cells = (r, t) => r.map((c) => `<${t}>${inline(c)}</${t}>`).join('');
        out.push(`<table border="1" style="border-collapse:collapse"><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`);
        rows = null;
      }
    };
    for (const raw of String(md).replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (list) close();
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) continue; // строка-разделитель
        rows = rows || [];
        rows.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      } else if ((m = line.match(/^\s*[-*•–]\s+(.*)$/))) {
        if (rows || (list && list.tag !== 'ul')) close();
        list = list || { tag: 'ul', items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (rows || (list && list.tag !== 'ol')) close();
        list = list || { tag: 'ol', items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        close();
        const level = Math.min(4, Math.max(2, m[1].length));
        out.push(`<h${level}>${inline(m[2].replace(/#+\s*$/, ''))}</h${level}>`);
      } else if (!line.trim()) {
        close();
      } else {
        close();
        out.push(`<p>${inline(line.trim())}</p>`);
      }
    }
    close();
    return out.join('');
  }
  const mdPlain = (md) => String(md).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();
  const mdStructured = (md) => /^\s*([-*•–]\s|\d+[.)]\s|#{1,6}\s|\|)/m.test(md);
  // Строки результата без разметки Markdown: «- пункт» → «пункт», «# Заголовок» → «Заголовок».
  const mdLines = (md) => mdPlain(md).split('\n').map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').trim()).filter(Boolean);

  const ai = { pop: null, sel: null, op: null, custom: '', result: '', abort: null };

  function aiClose() {
    if (ai.abort) ai.abort.abort();
    ai.abort = null;
    ai.pop?.remove();
    ai.pop = null;
  }
  function aiPlace(x, y) {
    const pop = ai.pop;
    const w = pop.offsetWidth; const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = y + h + 8 <= window.innerHeight ? y : Math.max(8, Math.min(y - h - 12, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  const KIND_TEXT = { clip: 'Клипы', track: 'Дорожки', marker: 'Маркеры', project: 'Проект' };
  const tc = (s) => { const t = Math.max(0, Math.round(Number(s) || 0)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); };
  // Что выделено: клипы, дорожки, маркеры или ничего (весь проект).
  async function aiSelection() {
    const d = await session();
    const sr = Number(d.sample_rate) || 48000;
    const tracks = d.tracks || [];
    const sel = d.selection || {};
    const clips = new Set(sel.clips || []);
    let items = [];
    if (clips.size) {
      for (const t of tracks) for (const c of t.clips || []) if (clips.has(c.id)) items.push({ kind: 'clip', id: c.id, name: c.name, track: t.name, at: secs(c.start, sr) });
    }
    if (!items.length && (sel.tracks || []).length) {
      const ids = new Set(sel.tracks);
      items = tracks.filter((t) => ids.has(t.id)).map((t) => ({ kind: 'track', id: t.id, name: t.name, comments: t.comments || '' }));
    }
    if (!items.length && (d.markers || []).length) {
      items = d.markers.map((m) => ({ kind: 'marker', id: m.number, name: m.name, at: secs(m.start, sr) }));
    }
    const kind = items.length ? items[0].kind : 'project';
    items = items.slice(0, 200);
    const text = kind === 'track' && items.length === 1 && items[0].comments
      ? `${items[0].name}\n\nКомментарий: ${items[0].comments}`
      : items.map((it) => (it.at != null ? `[${tc(it.at)}] ` : '') + it.name).join('\n');
    return { kind, items, text, project: projectOutline(d) };
  }
  // План проекта — контекст для модели: дорожки, клипы со временем, маркеры, комментарии.
  function projectOutline(d) {
    const sr = Number(d.sample_rate) || 48000;
    const out = [`Проект «${d.name}», длина ${tc(secs(d.length_samples, sr))}, ${sr} Гц.`];
    for (const t of d.tracks || []) {
      out.push(`Дорожка «${t.name}» (${KIND_RU[t.kind] || t.kind}, ${t.format})${t.comments ? ' — комментарий: ' + t.comments : ''}`);
      for (const c of (t.clips || []).slice(0, 80)) out.push(`  клип [${tc(secs(c.start, sr))}–${tc(secs(c.start + c.length, sr))}] ${c.name}`);
    }
    for (const m of d.markers || []) out.push(`Маркер ${m.number} [${tc(secs(m.start, sr))}] ${m.name}`);
    return out.join('\n');
  }
  async function aiOpen(x, y) {
    aiClose();
    if (!PC.ready()) return;
    let sel;
    try { sel = await aiSelection(); } catch { toast('Редактор ещё загружается.', true); return; }
    sel.text = String(sel.text || '').slice(0, CFG.aiMaxChars || 60000);
    ai.sel = sel;
    const n = sel.items.length;
    const what = KIND_TEXT[sel.kind];
    const first = sel.items.slice(0, 3).map((it) => it.name).join(', ') + (n > 3 ? '…' : '');
    const pop = document.createElement('div');
    pop.className = 'st-ai-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'ИИ-помощник');
    pop.innerHTML = `
      <div class="st-ai-head">
        <span class="st-ai-mark">${ICON.spark}</span>
        <input class="st-ai-input" type="text" placeholder="${n ? 'Что сделать с названиями?' : 'Что написать о проекте?'}" aria-label="Свой запрос или поиск по меню" autocomplete="off">
        <button class="st-ai-x" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
      </div>
      <div class="st-ai-scope">${n ? `${esc(what)}: <b>${esc(first.length > 80 ? first.slice(0, 80) + '…' : first)}</b> · ${n} ${plural(n, 'шт.', 'шт.', 'шт.')}` : 'Ничего не выделено и маркеров нет — работаю с проектом целиком. Чтобы переименовать, выделите клипы или дорожки.'}</div>
      <div class="st-ai-body"></div>
      <div class="st-ai-foot">Enter — свой запрос · Esc — закрыть · Ctrl+Alt+Пробел — открыть над окном</div>`;
    root.appendChild(pop);
    ai.pop = pop;
    const input = pop.querySelector('.st-ai-input');
    pop.querySelector('.st-ai-x').onclick = aiClose;
    input.addEventListener('input', () => aiMenu(input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); aiClose(); }
      if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); aiRun('custom', input.value.trim()); }
      if (e.key === 'ArrowDown') { e.preventDefault(); pop.querySelector('.st-ai-item')?.focus(); }
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); aiClose(); }
      const items = [...pop.querySelectorAll('.st-ai-item')];
      const i = items.indexOf(document.activeElement);
      if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault(); e.stopPropagation();
        (items[i + (e.key === 'ArrowDown' ? 1 : -1)] || (e.key === 'ArrowUp' ? input : items[i])).focus();
      }
    });
    aiMenu('');
    ai.anchor = [x, y];
    aiPlace(x, y);
    input.focus();
  }
  function plural(n, one, few, many) {
    const d = n % 10; const h = n % 100;
    return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  }
  // Пункт меню доступен, если есть с чем работать: названия — при выделении, комментарий — у одной дорожки.
  function aiAllowed(id) {
    const s = ai.sel || { kind: 'project', items: [] };
    if (AI_NAMES.test(id)) return s.items.length > 0;
    if (AI_COMMENT.test(id)) return s.kind === 'track' && s.items.length === 1 && (id === 'comment_write' || !!s.items[0].comments);
    return true;
  }
  function aiMenu(query) {
    const body = ai.pop?.querySelector('.st-ai-body');
    if (!body) return;
    const q = query.trim().toLowerCase();
    const groups = AI_MENU
      .map(([g, items]) => [g, items.filter(([id, label]) => (!q || label.toLowerCase().includes(q) || g.toLowerCase().includes(q)) && aiAllowed(id))])
      .filter((g) => g[1].length);
    body.innerHTML = groups.length
      ? groups.map(([g, items]) => `<div class="st-ai-group"><div class="st-ai-gt">${esc(g)}</div><div class="st-ai-items">${items.map(([id, label]) => `<button class="st-ai-item" data-op="${id}">${esc(label)}</button>`).join('')}</div></div>`).join('')
      : `<button class="st-ai-item st-ai-custom" data-op="custom">${ICON.send}<span>Выполнить: «${esc(query.trim())}»</span></button>`;
    body.querySelectorAll('.st-ai-item').forEach((b) => {
      b.onclick = () => (b.dataset.op === 'custom' ? aiRun('custom', query.trim()) : aiRun(b.dataset.op, ''));
    });
    if (ai.anchor) aiPlace(...ai.anchor);
  }
  // Что можно сделать с результатом: [действие, подпись, главное?].
  function aiActions(op) {
    const s = ai.sel || { items: [] };
    const acts = [];
    if ((AI_NAMES.test(op) || op === 'custom') && s.items.length) acts.push(['rename', `Применить к названиям (${s.items.length})`, AI_NAMES.test(op)]);
    if ((AI_COMMENT.test(op) || op === 'custom') && s.kind === 'track' && s.items.length === 1) acts.push(['comment', 'Записать в комментарий дорожки', AI_COMMENT.test(op)]);
    return acts;
  }
  async function aiRun(op, custom) {
    if (!ai.pop) return;
    ai.op = op; ai.custom = custom;
    const body = ai.pop.querySelector('.st-ai-body');
    const title = op === 'custom' ? custom : (AI_LABEL[op] || op);
    body.innerHTML = `<div class="st-ai-res"><div class="st-ai-rt">${esc(title)}</div><div class="st-ai-wait"><div class="st-typing"><i></i><i></i><i></i></div><span>Думаю…</span><button class="st-mini" data-a="stop">Отменить</button></div></div>`;
    ai.pop.querySelector('.st-ai-foot').hidden = true;
    body.querySelector('[data-a="stop"]').onclick = () => { ai.abort?.abort(); aiMenu(ai.pop.querySelector('.st-ai-input').value); ai.pop.querySelector('.st-ai-foot').hidden = false; };
    aiPlace(...ai.anchor);
    const sel = ai.sel || { kind: 'project', items: [], text: '', project: '' };
    let extra = '';
    if (AI_NAMES.test(op) || op === 'custom') extra = `Элементов: ${sel.items.length} (${(KIND_TEXT[sel.kind] || '').toLowerCase()}). Если задача — названия, верни ровно ${sel.items.length} строк, по одной на элемент, в том же порядке, без номеров и таймкодов.`;
    ai.abort = new AbortController();
    const payload = { mode: 'text', op: op === 'custom' ? '' : op, custom: op === 'custom' ? custom : '', extra, kind: sel.kind, selection: sel.text || '', document: sel.project || '' };
    let j;
    try {
      const r = await fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ai.abort.signal });
      j = await readAnswer(r);
    } catch (e) {
      if (e.name === 'AbortError') return;
      j = { ok: false, error: e.message };
    }
    ai.abort = null;
    if (!ai.pop) return;
    if (!j || !j.ok) {
      body.innerHTML = `<div class="st-ai-res"><div class="st-ai-rt">${esc(title)}</div><p class="st-ai-err">${esc((j && j.error) || 'Модель не ответила.')}</p><div class="st-ai-acts"><button class="st-mini" data-a="back">Назад</button><button class="st-mini" data-a="again">Ещё раз</button></div></div>`;
    } else {
      ai.result = String(j.message?.content || '').trim();
      const acts = aiActions(op);
      body.innerHTML = `<div class="st-ai-res">
        <div class="st-ai-rt">${esc(title)}<small>${esc(j.context === 'windowed' ? 'проект большой: учтена его часть' : 'учтён весь проект')}</small></div>
        <div class="st-ai-out">${mdToHtml(ai.result) || '<p>(пустой ответ)</p>'}</div>
        <div class="st-ai-acts">
          ${acts.map(([a, label, main]) => `<button class="st-mini ${main ? 'primary' : ''}" data-a="${a}">${esc(label)}</button>`).join('')}
          <button class="st-mini ${acts.some((x) => x[2]) ? '' : 'primary'}" data-a="copy">Копировать</button>
          <button class="st-mini" data-a="again" title="Другой вариант">Ещё вариант</button>
          <button class="st-mini" data-a="back">Назад</button>
        </div></div>`;
    }
    body.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => aiAction(b.dataset.a); });
    aiPlace(...ai.anchor);
    body.querySelector('.primary, [data-a="again"]')?.focus();
  }
  // Строка-название без таймкода и кавычек.
  const nameLine = (l) => l.replace(/^\[[\d:]+\]\s*/, '').replace(/^["«„]|["»“]$/g, '').trim().slice(0, 120);
  async function aiAction(a) {
    if (a === 'back') { aiMenu(ai.pop.querySelector('.st-ai-input').value); ai.pop.querySelector('.st-ai-foot').hidden = false; return; }
    if (a === 'again') { aiRun(ai.op, ai.custom); return; }
    if (a === 'copy') {
      const text = mdPlain(ai.result);
      try { await navigator.clipboard.writeText(text); } catch {
        const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
        t.remove();
      }
      toast('Скопировано');
      return;
    }
    const sel = ai.sel || { items: [] };
    try {
      if (a === 'rename') {
        const lines = mdLines(ai.result).map(nameLine).filter(Boolean);
        if (lines.length !== sel.items.length) throw new Error(`модель вернула ${lines.length} названий, а элементов ${sel.items.length}. Нажмите «Ещё вариант»`);
        let steps = 0;
        for (let i = 0; i < lines.length; i++) {
          const it = sel.items[i];
          if (lines[i] === it.name) continue;
          if (it.kind === 'clip') await PC.exec('clip.rename', { clip: it.id, name: lines[i] });
          else if (it.kind === 'track') await PC.exec('track.rename', { track: it.id, name: lines[i] });
          else if (it.kind === 'marker') await PC.exec('markers.edit', { number: it.id, name: lines[i] });
          steps++;
        }
        aiClose();
        toast(steps ? `Переименовано: ${steps}. Отменить — Ctrl+Z` : 'Названия и так такие.');
        return;
      }
      if (a === 'comment') {
        const it = sel.items[0];
        await PC.exec('track.comments', { track: it.id, comments: mdPlain(ai.result).slice(0, 4000) });
        aiClose();
        toast('Комментарий записан. Отменить — Ctrl+Z');
      }
    } catch (e) {
      toast('Не получилось: ' + e.message, true);
    }
  }
  window.addEventListener('aiaudition:ai', (e) => {
    const c = document.getElementById('soundcraft_canvas');
    const r = c ? c.getBoundingClientRect() : { left: 0, top: 0 };
    const d = e.detail || {};
    aiOpen(r.left + (Number(d.x) || 0), r.top + (Number(d.y) || 0));
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.altKey && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = document.getElementById('soundcraft_canvas');
      const r = c ? c.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
      aiOpen(r.left + Math.max(40, r.width / 2 - 200), r.top + Math.max(80, r.height / 4));
    }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (ai.pop && !ai.pop.contains(e.target) && !ai.abort) aiClose(); }, true);

  // ------------------------------------------------------------------ тема
  // Тема редактора: фирменная (по умолчанию), светлая или тёмная. Панель — в тон.
  const THEMES = [['brand', 'Фирменная'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  const systemDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function applyPanelTheme(themeId) {
    root.dataset.theme = themeId === 'brand' ? 'brand' : (themeId === 'dark' || (themeId === 'system' && systemDark()) ? 'dark' : 'light');
    document.documentElement.classList.toggle('studio-brand', themeId === 'brand');
    renderThemeMenu(themeId);
  }
  const syncBackdrop = () => {};
  function renderThemeMenu(current) {
    const menu = $('themeMenu');
    if (!menu) return;
    menu.innerHTML = THEMES.map((t) => `<button role="menuitemradio" aria-checked="${t[0] === current}" data-theme-id="${t[0]}">${esc(t[1])}</button>`).join('');
    menu.querySelectorAll('button').forEach((b) => { b.onclick = () => { toggleThemeMenu(false); setTheme(b.dataset.themeId); }; });
  }
  function toggleThemeMenu(open) {
    const menu = $('themeMenu');
    if (!menu) return;
    const show = open == null ? menu.hidden : open;
    menu.hidden = !show;
    $('theme').setAttribute('aria-expanded', String(show));
  }
  async function setTheme(themeId) {
    applyPanelTheme(themeId);
    store.set('theme', themeId);
    if (PC.ready()) await PC.exec('ui.theme', { mode: themeId }).catch(() => {});
  }
  // Тема, которая сейчас в редакторе, как бы её ни выбрали (Установка › Настройки, список в панели).
  async function watchTheme() {
    for (;;) {
      if (!document.hidden && PC.ready()) {
        try {
          const ui = await PC.call('ui.inspect');
          const id = ui && ui.ui && ui.ui.theme;
          if (typeof id === 'string') applyPanelTheme(id === 'brand' ? 'brand' : id);
          // Заголовок вкладки браузера — имя проекта (окно браузера редактор сам не переименует).
          const d = await session().catch(() => null);
          document.title = d && d.name ? `${d.name}${d.dirty ? ' •' : ''} — AI-Audition` : 'AI-Audition';
        } catch { /* не важно */ }
      }
      await sleep(2000);
    }
  }

  async function status() {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin' });
      const j = await r.json();
      if (j.ok) {
        if (Number(j.ctx) > 0) CTX = Number(j.ctx);
        if (j.source) $('sub').title = 'Откуда взята модель: ' + j.source;
        $('sub').textContent = 'Модель: ' + j.model;
        fetch('studio/version.json', { cache: 'no-store' }).then((v) => (v.ok ? v.json() : null)).then((v) => {
          if (!v || !v.build) return;
          const d = String(v.date || '').split('-').reverse().join('.');
          $('sub').textContent = 'Модель: ' + j.model + ' · сборка ' + v.build + (d ? ' от ' + d : '');
          const pageBuild = document.documentElement.dataset.build;
          if (pageBuild && pageBuild !== String(v.build)) {
            const page = +pageBuild, server = +v.build;
            if (page > server) {
              msg('note', `Страница — от сборки ${esc(pageBuild)}, а файлы на сервере частично остались от сборки ${esc(String(v.build))}: ` +
                'программа заливки, похоже, пропустила файлы того же размера. Удалите старую папку на сервере целиком и залейте новую ' +
                '(или включите в программе «перезаписывать всегда»).');
            } else {
              msg('note', `Открыта старая копия страницы из кэша браузера (сборка ${esc(pageBuild)}), а на сервере уже сборка ${esc(String(v.build))}. Нажмите <b>Ctrl+F5</b>, чтобы загрузить новую.`);
            }
          }
        }).catch(() => {});
      }
      else $('sub').textContent = j.login ? 'Нужно войти в систему' : (j.error || 'Нет связи с помощником');
    } catch {
      $('sub').textContent = 'Нет связи с сервером помощника';
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; }

  function mount() {
    document.body.appendChild(root);
    root.querySelectorAll('.st-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $('eye').onclick = () => setEye(!attachScreen);
    initAgentMenu();
    $('hide').onclick = () => setOpen(false);
    $('fab').onclick = () => { setOpen(true); setBadge(false); };
    $('send').onclick = () => send();
    $('barBtn').onclick = () => setBar(!root.classList.contains('bar-open'));
    $('barSend').onclick = () => (busy ? send() : sendFromBar());
    $('barMode').onclick = () => setMode(mode === 'act' ? 'advice' : 'act');
    barInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFromBar(); }
      if (e.key === 'Escape') { e.preventDefault(); setBar(false); }
    });
    $('clear').onclick = () => { if (!busy) { convo = []; showEmpty(); } };
    // Луна/солнце — между светлой и тёмной неоморфными; из фирменной — в светлую.
    $('theme').onclick = (e) => { e.stopPropagation(); toggleThemeMenu(); };
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest || !e.target.closest('.st-theme-wrap')) toggleThemeMenu(false); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleThemeMenu(false); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    setMode(mode);
    setEye(attachScreen);
    applyPanelTheme('brand');
    showEmpty();
    status();
  }

  async function boot() {
    mount();
    // Ждём, пока WebAssembly загрузится и поставит window.aiaudition, а редактор запустится и начнёт отвечать.
    while (!PC.ready()) await sleep(200);
    for (let i = 0; i < 600; i++) {
      try { await PC.call('ui.inspect'); break; } catch { await sleep(300); }
    }
    Files.start();
    // Тема, выбранная в этом браузере раньше (редактор каждый раз начинает с фирменной).
    const saved = store.get('theme', 'brand');
    if (saved !== 'brand') setTheme(saved);
    await sleep(300);
    root.classList.add('ready');
    if (store.get('open', CFG.openOnStart)) setOpen(true);
    commands().catch(() => {});
    watchTheme();
    Gallery.start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
