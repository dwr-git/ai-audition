<?php
// studio/api/context.php — ИИ-помощник у выделения в AI Звук (кнопка «ИИ» в строке меню
// редактора). Подключается из assistant.php для запросов {mode: "text", op, custom?, extra?, kind,
// selection, document}.
//
// Текст в звуковом проекте — это названия клипов, дорожек и маркеров и комментарии к дорожкам.
// Модель видит план всего проекта (дорожки, клипы со временем, маркеры), а работает с выделенным:
// предлагает названия (по одному на строку, в том же порядке), пишет комментарий к дорожке,
// главы с таймкодами или описание выпуска.
// Большой проект передаётся не целиком: начало, оглавление и окно вокруг выделения.

declare(strict_types=1);

/** Сколько токенов документа (≈ символов / 3,5) отдавать целиком. */
const STUDIO_CONTEXT_TOKENS = 16000;
/** Сколько символов брать по обе стороны от выделения в большом документе. */
const STUDIO_CONTEXT_WINDOW = 3000;
/** Больше этого текст документа не принимаем вовсе. */
const STUDIO_CONTEXT_MAX_CHARS = 2000000;

/** Задания операций меню. Ключи — id пунктов меню в studio.js. */
function studio_context_prompt(string $op): ?string
{
    $only = ' Верни ТОЛЬКО результат, без вступлений и пояснений.';
    $names = ' Верни столько строк, сколько элементов в выделении, по одной на элемент и в том же порядке, без номеров, маркеров списка, таймкодов и кавычек.';
    $p = [
        'names_clear' => 'Дай элементам понятные короткие названия (2–5 слов) по их роли в проекте: ведущий, гость, вступление, реклама, музыка и т. п. Если роль не ясна из плана проекта, сделай название аккуратнее, не выдумывая.' . $names . $only,
        'names_fix' => 'Исправь в названиях опечатки, регистр и лишние символы (подчёркивания, номера дублей вроде _01, расширения файлов). Смысл не меняй.' . $names . $only,
        'names_short' => 'Сократи названия до 1–3 слов, сохранив смысл.' . $names . $only,
        'comment_write' => 'Напиши короткий рабочий комментарий к дорожке (1–3 предложения): что на ней и что с ней делать при сведении, по плану проекта.' . $only,
        'comment_improve' => 'Улучши комментарий к дорожке: ясно и коротко, исправь ошибки, сохрани смысл.' . $only,
        'chapters' => 'Составь главы выпуска для описания подкаста: строки вида «0:00 Название главы» по маркерам и клипам проекта, по порядку времени. Не придумывай тем, которых нет в названиях.' . $only,
        'description' => 'Напиши описание выпуска подкаста (3–6 предложений) по названиям дорожек, клипов, маркеров и комментариям. Не выдумывай фактов, которых там нет; если данных мало — напиши общее описание и отметь [что уточнить].' . $only,
        'titles' => 'Предложи 5 вариантов названия выпуска (до 8 слов) нумерованным списком, по содержанию проекта.' . $only,
        'summary' => 'Кратко опиши, что есть в проекте: дорожки, сколько клипов, маркеры, длина, что бросается в глаза для монтажа и сведения. Маркированный список Markdown.',
    ];
    $langs = ['translate_ru' => 'русский', 'translate_en' => 'английский'];
    if (isset($langs[$op])) {
        return "Переведи названия на {$langs[$op]} язык." . $names . $only;
    }
    return $p[$op] ?? null;
}

/** Операции, которым без выделения нужен весь проект. */
function studio_context_whole_doc_ops(): array
{
    return ['chapters', 'description', 'titles', 'summary'];
}

/** Документ целиком или (если велик) начало, оглавление и окно вокруг выделения. */
function studio_context_block(string $doc, string $selected): array
{
    $len = mb_strlen($doc, 'UTF-8');
    if ((int)($len / 3.5) <= STUDIO_CONTEXT_TOKENS) {
        return ['full', "=== ПЛАН ПРОЕКТА ЦЕЛИКОМ ===\n" . $doc . "\n=== КОНЕЦ ПЛАНА ПРОЕКТА ===\n"];
    }
    $anchor = (int)($len / 2);
    if ($selected !== '') {
        $probe = mb_substr($selected, 0, 200, 'UTF-8');
        $p = mb_strpos($doc, $probe, 0, 'UTF-8');
        if ($p !== false) {
            $anchor = $p + (int)(mb_strlen($selected, 'UTF-8') / 2);
        }
    }
    $start = max(0, $anchor - STUDIO_CONTEXT_WINDOW);
    $end = min($len, $anchor + STUDIO_CONTEXT_WINDOW);
    $toc = [];
    foreach (preg_split('/\R/u', $doc) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || mb_strlen($line, 'UTF-8') >= 100) {
            continue;
        }
        if (mb_strtoupper($line, 'UTF-8') === $line || !preg_match('/[.!?;:,]$/u', $line)) {
            $toc[] = '• ' . $line;
        }
        if (count($toc) >= 40) {
            break;
        }
    }
    $block = "=== ПРОЕКТ БОЛЬШОЙ: ПОКАЗАНЫ НАЧАЛО, ОГЛАВЛЕНИЕ И ФРАГМЕНТ ВОКРУГ ВЫДЕЛЕНИЯ ===\n"
        . "--- Начало ---\n" . mb_substr($doc, 0, 800, 'UTF-8') . "\n"
        . "--- Оглавление ---\n" . implode("\n", $toc) . "\n"
        . "--- Фрагмент (символы {$start}–{$end} из {$len}) ---\n" . mb_substr($doc, $start, $end - $start, 'UTF-8') . "\n=== КОНЕЦ ===\n";
    return ['windowed', $block];
}

/**
 * Системная инструкция и сообщения для модели по запросу панели.
 * Возвращает [system, messages, contextMode]; при ошибке завершает запрос через studio_fail.
 */
function studio_context_request(array $in): array
{
    $op = is_string($in['op'] ?? null) ? trim($in['op']) : '';
    $custom = is_string($in['custom'] ?? null) ? trim(mb_substr($in['custom'], 0, 4000, 'UTF-8')) : '';
    $extra = is_string($in['extra'] ?? null) ? trim(mb_substr($in['extra'], 0, 2000, 'UTF-8')) : '';
    $selected = is_string($in['selection'] ?? null) ? $in['selection'] : '';
    $doc = is_string($in['document'] ?? null) ? $in['document'] : '';
    if (mb_strlen($doc, 'UTF-8') > STUDIO_CONTEXT_MAX_CHARS) {
        $doc = mb_substr($doc, 0, STUDIO_CONTEXT_MAX_CHARS, 'UTF-8');
    }
    $selected = mb_substr($selected, 0, 60000, 'UTF-8');

    if ($custom !== '') {
        $task = $custom;
    } else {
        $task = studio_context_prompt($op);
        if ($task === null) {
            studio_fail(400, 'Неизвестная операция: ' . $op);
        }
    }
    if ($extra !== '') {
        $task .= "\n\nДополнительное пожелание: " . $extra;
    }

    $kinds = ['clip' => 'названия клипов', 'track' => 'дорожки (название и комментарий)', 'marker' => 'названия маркеров', 'project' => 'проект целиком'];
    $kind = is_string($in['kind'] ?? null) && isset($kinds[$in['kind']]) ? $in['kind'] : 'project';
    $system = implode("\n", [
        'Ты — ИИ-помощник, встроенный в звуковой редактор AI Звук (многодорожечный монтаж и сведение; чаще всего подкасты, интервью, озвучка).',
        'Звук ты не слышишь: ты видишь только план проекта — дорожки, клипы со временем, маркеры и комментарии.',
        'Работаешь с выделенным: ' . $kinds[$kind] . '. Остальной план проекта — контекст.',
        'Отвечай без вступлений вроде «Вот названия:», без извинений и комментариев о себе.',
        'Сохраняй язык исходных названий, если задача — не перевод; по умолчанию пиши по-русски.',
    ]);
    [$mode, $context] = studio_context_block($doc, $selected);
    if ($selected !== '') {
        $target = "=== ВЫДЕЛЕНО ===\n" . $selected . "\n=== КОНЕЦ ВЫДЕЛЕННОГО ===\n\n"
            . 'Выполни задачу ТОЛЬКО для выделенного; план проекта выше — контекст.';
    } elseif (in_array($op, studio_context_whole_doc_ops(), true) || $custom !== '') {
        $target = 'Выделения нет: работай с проектом целиком.';
    } else {
        $target = 'Выделения нет: выполни задачу для показанного плана проекта.';
    }
    $user = ($doc !== '' ? $context . "\n" : '') . $target . "\n\n=== ЗАДАЧА ===\n" . $task;
    return [$system, [['role' => 'user', 'content' => $user]], $mode];
}
