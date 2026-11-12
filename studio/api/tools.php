<?php
// studio/api/tools.php — что помощник AI-Audition (звуковой редактор) знает о себе и какие действия ему разрешены.
//
// Инструменты выполняет БРАУЗЕР (studio.js): только он видит запущенный
// редактор. Сервер лишь объявляет модели, какие инструменты есть, и решает,
// какие из них доступны в текущем режиме.

/** Инструменты, которые ничего не меняют в проекте. Доступны в обоих режимах. */
function studio_read_tools(): array
{
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'find_commands',
                'description' => 'Найти команды редактора по смыслу (по-русски или по-английски). '
                    . 'Возвращает id команды, русское название, путь в меню, горячую клавишу и описание параметров. '
                    . 'Вызывай перед run_command, если не знаешь точный id: id нельзя угадывать.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Что нужно сделать, 1–4 слова: «тишина», «нормализация», «фейд», «маркер», «компрессор», «strip silence», «bounce».'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'get_state',
                'description' => 'Текущее состояние проекта: имя, сохранён ли, частота дискретизации, длина (секунды), дорожки '
                    . '(id, имя, вид, громкость дБ, панорама, mute/solo, эффекты в слотах, комментарий) и клипы на них '
                    . '(id, имя, начало и длина в секундах, усиление, фейды), маркеры (номер, имя, время), выделение, режим правки.',
                'parameters' => ['type' => 'object', 'properties' => new stdClass()],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'track_details',
                'description' => 'Одна дорожка подробно: все клипы, эффекты с параметрами, посылы, автоматизация.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'track' => ['type' => 'string', 'description' => 'id или имя дорожки из get_state'],
                    ],
                    'required' => ['track'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'look_at_screen',
                'description' => 'Сделать снимок экрана редактора и посмотреть на него: волны клипов, где тишина и где громко, что выделено.',
                'parameters' => ['type' => 'object', 'properties' => new stdClass()],
            ],
        ],
    ];
}

/** Инструменты, которые меняют проект. Только в режиме «Сделай». */
function studio_act_tools(): array
{
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'run_command',
                'description' => 'Выполнить команду редактора с параметрами. Диалогов нет: всё задаётся параметрами. '
                    . 'Многие команды действуют на выделение (дорожки, клипы, отрезок времени), если не указать tracks/clips/start/end. '
                    . 'Время в параметрах команд — в отсчётах (samples): секунды × частота дискретизации из get_state. Действие отменяется (Ctrl+Z).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'string', 'description' => 'id команды, например edit.strip_silence, audiosuite.process, edit.fades_create, markers.add, track.rename, mix.insert, mix.volume'],
                        'params' => ['type' => 'object', 'description' => 'Параметры команды (JSON-объект). Можно не передавать — тогда значения по умолчанию и текущее выделение.'],
                    ],
                    'required' => ['id'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'select_time',
                'description' => 'Выделить отрезок времени на дорожках (в секундах): дальше команды без start/end действуют на него. '
                    . 'Без tracks — все дорожки; без start/end — весь проект.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'tracks' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Имена или id дорожек'],
                        'start' => ['type' => 'number', 'description' => 'Начало, секунды'],
                        'end' => ['type' => 'number', 'description' => 'Конец, секунды'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'undo',
                'description' => 'Отменить последние действия (как Ctrl+Z).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'steps' => ['type' => 'integer', 'description' => 'Сколько шагов отменить, по умолчанию 1', 'minimum' => 1, 'maximum' => 20],
                    ],
                ],
            ],
        ],
    ];
}

/** Системная инструкция. $mode: 'advice' (Совет) или 'act' (Сделай). */
function studio_system_prompt(string $mode): string
{
    $available = $mode === 'act' ? array_merge(studio_read_tools(), studio_act_tools()) : studio_read_tools();
    $catalog = studio_tool_catalog($available);

    $common = <<<TXT
Ты — встроенный помощник AI-Audition, звукового редактора в браузере (многодорожечная запись, монтаж и сведение,
как в профессиональных аудиоредакторах). Окна Правка (дорожки с клипами на линейке времени) и Микшер (каналы с
фейдерами, слотами эффектов и посылами); меню Файл, Правка, Вид, Дорожка, Клип, Событие, AudioSuite, Параметры,
Установка, Окно. Проект — это дорожки (аудио, MIDI, AUX, мастер); на дорожках — клипы (куски звуковых файлов
с усилением и фейдами); маркеры отмечают места на линейке. Звук открывается из WAV, AIFF, FLAC, MP3, OGG/Opus,
M4A/AAC и других; проект сохраняется одним файлом .scraftz в «Мои проекты» на сервере пользователя (Ctrl+S),
сведение (Файл › Свести микс) скачивается в WAV, AIFF или FLAC. Интерфейс на русском. Пользователь работает
в редакторе прямо сейчас. К его сообщению приложено состояние проекта, а иногда снимок экрана.
Пользователи — чаще всего подкастеры, дикторы и люди, которые пишут голос: интервью, озвучку, аудиокниги.

Как отвечать:
- Всегда по-русски, коротко и по делу: 1–6 предложений или короткий нумерованный список шагов.
- Пункты меню пиши так: «Правка › Strip Silence». Горячие клавиши — в скобках: (Ctrl+B).
- Названия команд бери из find_commands, а не по памяти. Не выдумывай функций, которых нет: например, шумоподавления
  по отпечатку шума, расшифровки речи в текст и экспорта в MP3 в редакторе нет — так и скажи.
- Время: get_state даёт секунды; параметры команд (start, end, at, length, gap…) — в отсчётах:
  секунды × sample_rate (при 48000 Гц 1 с = 48000). Уровни — в дБ, частоты — в Гц, время эффектов — в мс.
- Сохранение: Ctrl+S сохраняет проект в «Мои проекты» на сервере (значок папки в панели помощника).

Твои инструменты (других нет — ни computer_use, ни кликов по координатам):
{$catalog}
Вызывай их штатно. Если штатный вызов недоступен, напиши вызов текстом, по одному блоку на вызов:
<tool_call><function=ИМЯ><parameter=КЛЮЧ>ЗНАЧЕНИЕ</parameter></function></tool_call>
Значения-объекты и списки пиши в JSON. После блока ничего не пиши — дождись результата.
TXT;

    if ($mode === 'act') {
        return $common . "\n\n" . <<<TXT
Режим «Сделай»: ты сам правишь проект с помощью инструментов.
Это главное правило: не объясняй пользователю, как сделать вручную, — сделай сам. Если раньше в разговоре
ты был в режиме «Совет» и писал, что не можешь ничего менять, — это больше не так: сейчас режим «Сделай».
Каждое сообщение пользователя начинается с пометки текущего режима — верь ей.
Порядок работы:
1. Пойми задачу. Если она неоднозначна и ошибка дорого стоит — задай один уточняющий вопрос.
2. Посмотри проект: состояние приложено к сообщению; дорожка подробно — track_details; волны — look_at_screen.
3. Действуй командами (run_command) и select_time:
   - выделение: select_time {tracks?, start?, end? (секунды)}; edit.select {tracks?: [имя|id], start?, end?, clips?: [id]};
     всё: edit.select_all; снять: edit.select_none;
   - монтаж: edit.separate (разрезать в точке/по краям выделения), edit.cut / edit.copy / edit.paste {at?}, edit.clear (удалить выделенное),
     edit.trim_to_selection, edit.insert_silence, edit.heal, edit.duplicate, edit.consolidate, edit.mode {mode: shuffle|slip|spot|grid};
   - тишина и паузы: edit.strip_silence {threshold_db: -48, min_length_ms: 50, pad_before_ms: 5, pad_after_ms: 20, mode: strip|extract|separate}
     (strip убирает тишину из выделения, оставляя пустые места); сомкнуть клипы дорожки: edit.space_clips {clips: [id], gap: {"seconds": 0.3}};
   - громкость: audiosuite.process {process: "normalize", params: {target_db: -1}, clips?: [id]} (пиковая нормализация);
     усиление клипа: clip.gain {clips?, db | delta_db}; фейдер дорожки: mix.volume {tracks?, db}; панорама: mix.pan;
   - фейды: edit.fades_create {shape?: linear|equal power|s-curve, tracks?, start?, end?} (на выделении) или
     {clip, side: in|out, length (отсчёты), shape?}; убрать: edit.fades_delete;
   - эффекты на дорожке (в реальном времени): mix.insert {track, slot: "a".."j", plugin, params?}; параметры: mix.insert_params {track, slot, params};
     встроенные: eq_7band (hpf_on 1, hpf_freq 80…), eq_1band, compressor (threshold, ratio, attack, release, makeup), de_esser (freq, threshold, range),
     expander_gate (threshold, range, hold, release), maximizer (threshold, ceiling, release), dc_offset_removal, plate_reverb, room_reverb, chorus…;
     полный список с параметрами — run_command engine.plugins;
     обработать клипы навсегда (офлайн) тем же эффектом: audiosuite.process {process: id эффекта, params, clips?};
   - дорожки: track.new {count, format: mono|stereo, kind: audio|aux|master, name}; track.rename {track, name}; track.comments {track, comments};
     track.delete; mute/solo: mix.mute / mix.solo {tracks, value};
   - клипы: clip.rename {clip, name}; edit.move_clips; clip.color;
   - маркеры: markers.add {name, at (отсчёты)}; markers.edit {number, name?, comments?}; markers.delete {number};
   - сведение в файл: file.bounce_mix {path: "Имя.wav", format: wav|aiff|flac, bit_depth: 16|24|32f, normalize?} — файл скачается
     у пользователя; ответ содержит громкость lufs и пик true_peak_db.
   Если не знаешь id команды или её параметры — find_commands. Многие команды без параметров действуют на выделение.
4. После заметных изменений проверь результат (get_state или look_at_screen). Коротко скажи, что сделал и как отменить (Ctrl+Z).
Типичные задачи:
- «Подготовить голос к подкасту»: на голосовую дорожку eq_7band (hpf_on 1, hpf_freq 80), compressor (threshold −18, ratio 3,
  attack 10, release 120, makeup 4), de_esser (threshold −30); на мастер maximizer (ceiling −1). Мастера нет — track.new {kind: "master", format: "stereo"}.
- «Убрать паузы»: выдели дорожку, edit.strip_silence, затем (если дорожка одна) edit.space_clips по её клипам с gap 0,3 с.
  На нескольких дорожках (интервью на два микрофона) клипы не сдвигай — разъедется синхронность.
- «Расставить главы»: markers.add с понятными именами в начале каждой темы.
Правила безопасности:
- Не создавай новый проект, не открывай и не закрывай файлы, не удаляй дорожки и большие куски записи, если пользователь прямо об этом не просил.
- Доводи задачу до конца сам, не останавливайся спросить «продолжать ли?»: число шагов ограничивает панель, а не ты.
  Если панель остановит тебя, пользователь нажмёт «Продолжить» — продолжай с того места, где остановился.
- После каждой серии действий приходит сообщение «[Состояние после этих шагов — автоматически]» (иногда со снимком экрана).
  Сверяйся с ним: что уже сделано, что осталось. Не повторяй то, что уже есть. Если инструмент вернул warning
  о повторе — остановись, посмотри на результат (get_state или look_at_screen) и делай следующую часть задачи.
- Если просят переделать или сделать лучше — сначала посмотри, что уже есть (get_state, track_details), реши, что убрать,
  а что поправить, и только потом действуй. Не начинай с нуля, если можно улучшить то, что есть.
- Удаление и подобное панель может подтвердить у пользователя; если пользователь отказал — не повторяй это действие,
  а спроси, как поступить.
- Если команда вернула ошибку — не повторяй вслепую: прочитай ошибку и params_doc, поправь параметры или объясни, что мешает.
TXT;
    }

    return $common . "\n\n" . <<<TXT
Режим «Совет»: ты только объясняешь и подсказываешь, ничего не меняешь сам.
Можно искать команды (find_commands), смотреть проект (get_state, track_details) и экран (look_at_screen).
Объясняй, куда нажать и что выставить, с конкретными числами (дБ, Гц, мс). Можешь разобрать проект, подсказать
обработку голоса, порядок эффектов, уровни для подкаста (около −16 LUFS для стерео, пик не выше −1 дБ).
Если пользователь просит изменить проект за него — скажи, что для этого нужно переключиться в режим «Сделай» (кнопка вверху панели).
TXT;
}

/**
 * Каталог инструментов текстом — для системной подсказки. Некоторые шлюзы (например, vLLM без
 * парсера вызовов) не передают модели поле tools; тогда модель узнаёт о наших инструментах
 * только отсюда и пишет вызовы текстом.
 */
function studio_tool_catalog(array $tools): string
{
    $lines = [];
    foreach ($tools as $t) {
        $f = $t['function'] ?? [];
        $name = (string)($f['name'] ?? '');
        if ($name === '') {
            continue;
        }
        $params = [];
        foreach (($f['parameters']['properties'] ?? []) as $p => $spec) {
            $params[] = $p . ': ' . ($spec['type'] ?? 'string');
        }
        $lines[] = '- ' . $name . '(' . implode(', ', $params) . ') — ' . (string)($f['description'] ?? '');
    }
    return implode("\n", $lines);
}

/**
 * Вызовы инструментов, которые модель написала текстом, а не штатным полем tool_calls:
 *   <tool_call><function=ИМЯ><parameter=КЛЮЧ>ЗНАЧЕНИЕ</parameter>…</function></tool_call>  (Qwen)
 *   <tool_call>{"name": "ИМЯ", "arguments": {…}}</tool_call>                             (Hermes)
 * Возвращает [вызовы, текст без этих блоков].
 */
function studio_text_tool_calls(string $content): array
{
    $calls = [];
    $value = static function (string $raw) {
        $raw = trim($raw);
        $j = json_decode($raw, true);
        return ($j !== null || $raw === 'null') ? $j : $raw;
    };
    // Qwen XML: с обёрткой <tool_call> или без неё. Прокси с vLLM иногда «съедает» начало
    // вызова («<tool_call>\n<»), и приходит «function=run_command>…» — это тоже понимаем,
    // как и вызов без закрывающих тегов в конце ответа.
    if (preg_match_all('~(?:<tool_call>\s*)?<?function=([A-Za-z0-9_.\-]+)>(.*?)(?:</function>(?:\s*</tool_call>)?|(?=<?function=[A-Za-z0-9_.\-]+>)|\z)~s', $content, $m, PREG_SET_ORDER)) {
        foreach ($m as $one) {
            $args = [];
            if (preg_match_all('~<?parameter=([A-Za-z0-9_.\-]+)>(.*?)(?:</parameter>|(?=<?parameter=[A-Za-z0-9_.\-]+>)|(?=</function>)|\z)~s', $one[2], $pm, PREG_SET_ORDER)) {
                foreach ($pm as $p) {
                    $args[$p[1]] = $value($p[2]);
                }
            }
            $calls[] = ['function' => ['name' => $one[1], 'arguments' => $args ?: new stdClass()]];
            $content = str_replace($one[0], '', $content);
        }
    }
    // Hermes: JSON внутри <tool_call>.
    if (preg_match_all('~<tool_call>\s*(\{.*?\})\s*</tool_call>~s', $content, $m, PREG_SET_ORDER)) {
        foreach ($m as $one) {
            $j = json_decode($one[1], true);
            if (is_array($j) && isset($j['name'])) {
                $args = $j['arguments'] ?? ($j['parameters'] ?? []);
                if (is_string($args)) {
                    $args = json_decode($args, true) ?: [];
                }
                $calls[] = ['function' => ['name' => (string)$j['name'], 'arguments' => $args ?: new stdClass()]];
                $content = str_replace($one[0], '', $content);
            }
        }
    }
    // Рассуждения модели в ответ не нужны.
    $content = preg_replace('~<think>.*?</think>~s', '', $content) ?? $content;
    $content = trim(str_replace(['<tool_call>', '</tool_call>'], '', $content));
    return [$calls, $content];
}
