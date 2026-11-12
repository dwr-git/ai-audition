<?php
// studio/api/files.php — «Мои проекты» AI Звук на вашем сервере. У каждого пользователя своя папка.
//
//   GET  files.php                          → {ok, user, files: [{name, size, modified}], limit}
//   GET  files.php?action=load&name=…       → сам файл (проект .scraftz/.scraft, звук, MIDI), application/octet-stream
//   POST files.php?action=save&name=…[&overwrite=1]   тело — байты файла → {ok, name, size, modified}
//   POST files.php?action=rename  {name, to}   → {ok}
//   POST files.php?action=delete  {name}       → {ok}  (файл уходит в корзину .trash/ папки пользователя)
//
// Хранятся проекты (.scraftz — один файл с проектом и всем его звуком, родной формат; .scraft — проект
// без звука) и звук, который редактор открывает: WAV/BWF/RF64, AIFF, FLAC, MP3, OGG/Opus, M4A/MP4/AAC,
// AC-3, CAF, MKA/WebM; а также MIDI. Содержимое проверяется по первым байтам.
// Самый большой файл — AI_AUDITION_MAX_MB мегабайт (по умолчанию 200). Столько же должны пропускать
// nginx (client_max_body_size) и PHP (post_max_size, upload_max_filesize): см. nginx.conf.example.
//
// Где лежат файлы: AI_AUDITION_DATA_DIR из .env, иначе storage/ai-audition рядом с корнем сайта
// (/app/storage/ai-audition при корне /app/src — вне корня, nginx её не отдаёт; создаётся сама),
// потом data/ai-audition, а если никуда нельзя писать — ai-audition-data рядом с папкой приложения
// (закройте её в nginx: см. nginx.conf.example).
// Имена файлов на диске случайные, список — в index.json папки пользователя.

declare(strict_types=1);

header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

function files_fail(int $http, string $message, array $extra = []): void
{
    http_response_code($http);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function files_ok(array $data): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

ini_set('display_errors', '0');
set_exception_handler(static function (Throwable $e): void {
    error_log('ai-audition files: ' . $e->getMessage());
    files_fail(500, 'Внутренняя ошибка хранилища файлов. Подробности — в журнале PHP.');
});

require_once __DIR__ . '/llm.php';
$STUDIO = require __DIR__ . '/settings.php';

// ---------------------------------------------------------------- кто это
$user = 'local';
if ($STUDIO['auth_file'] !== '' && is_file($STUDIO['auth_file'])) {
    require_once $STUDIO['auth_file'];
    if (!function_exists('isLoggedIn') || !isLoggedIn()) {
        files_fail(401, 'Войдите в систему, чтобы открыть свои файлы.', ['login' => true]);
    }
    $u = function_exists('getCurrentUser') ? getCurrentUser() : null;
    $id = is_array($u) ? ($u['id'] ?? $u['login'] ?? null) : null;
    if ($id === null || $id === '') {
        files_fail(500, 'auth.php не сообщил, кто вошёл (getCurrentUser).');
    }
    $user = (string)$id;
} elseif (!$STUDIO['allow_anonymous']) {
    files_fail(500, 'Не найден auth.php системы. Укажите путь в AI_AUDITION_AUTH_FILE (см. README.ru.md).');
}
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

// ---------------------------------------------------------------- где лежат файлы
function files_root(): string
{
    $env = studio_env('AI_AUDITION_DATA_DIR');
    if ($env !== '') {
        return rtrim($env, '/');
    }
    // Рядом с корнем сайта, но не внутри него: сначала папка storage (как /app/storage при корне
    // /app/src — туда же nginx пишет журналы), потом data. Берётся первая, куда PHP может писать.
    $docRoot = rtrim((string)($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    $parent = $docRoot !== '' ? dirname($docRoot) : '';
    $candidates = [];
    if ($parent !== '' && $parent !== '/' && is_dir("$parent/storage")) {
        $candidates[] = "$parent/storage/ai-audition";
    }
    if ($parent !== '' && $parent !== '/') {
        $candidates[] = "$parent/data/ai-audition";
    }
    foreach ($candidates as $dir) {
        if ((is_dir($dir) && is_writable($dir)) || (!is_dir($dir) && @mkdir($dir, 0770, true))) {
            return $dir;
        }
    }
    return dirname(__DIR__, 2) . '/ai-audition-data';
}

$root = files_root();
if (!is_dir($root) && !@mkdir($root, 0770, true) && !is_dir($root)) {
    files_fail(500, "Не удалось создать папку для файлов: $root. Создайте её и дайте PHP право записи (или укажите AI_AUDITION_DATA_DIR).");
}
// Если папка всё же внутри сайта — закрываем её для Apache и не даём листать.
if (!is_file("$root/.htaccess")) {
    @file_put_contents("$root/.htaccess", "Require all denied\n");
}
if (!is_file("$root/index.html")) {
    @file_put_contents("$root/index.html", '');
}
$dir = $root . '/u-' . preg_replace('/[^A-Za-z0-9_-]/', '_', $user);
if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
    files_fail(500, 'Не удалось создать папку пользователя. Проверьте права PHP на ' . $root);
}

/** Самый большой файл: AI_AUDITION_MAX_MB мегабайт (1…4096, по умолчанию 200). */
$__maxMb = (int)studio_env('AI_AUDITION_MAX_MB', '200');
define('FILES_MAX_MB', $__maxMb >= 1 && $__maxMb <= 4096 ? $__maxMb : 200);
define('FILES_MAX_BYTES', FILES_MAX_MB * 1024 * 1024);
const FILES_MAX_COUNT = 2000;
/** Типы файлов, которые хранятся (расширение имени на сервере и на диске). */
// .scraftz — родной формат (проект и весь его звук одним файлом, zip); .scraft — проект без звука (JSON);
// звук и MIDI открываются в проекте новыми дорожками.
const FILES_EXTS = ['scraftz', 'scraft', 'wav', 'wave', 'bwf', 'rf64', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'mp2', 'ogg', 'oga', 'opus',
    'm4a', 'm4b', 'mp4', 'aac', 'ac3', 'caf', 'mka', 'webm', 'mid', 'midi'];
const FILES_STORED = '/^[0-9a-f]{32}\.(scraftz|scraft|wav|wave|bwf|rf64|aif|aiff|aifc|flac|mp3|mp2|ogg|oga|opus|m4a|m4b|mp4|aac|ac3|caf|mka|webm|mid|midi)$/';

/** Похожи ли первые байты файла на заявленный по расширению тип. */
function files_magic_ok(string $ext, string $head): bool
{
    $at = static fn(int $o, string $s): bool => substr($head, $o, strlen($s)) === $s;
    $riff = ($at(0, 'RIFF') || $at(0, 'RF64') || $at(0, 'BW64')) && $at(8, 'WAVE');
    $aiff = $at(0, 'FORM') && ($at(8, 'AIFF') || $at(8, 'AIFC'));
    $b0 = strlen($head) > 0 ? ord($head[0]) : 0;
    $b1 = strlen($head) > 1 ? ord($head[1]) : 0;
    // MPEG-аудио: ID3-тег или кадр (11 единичных бит синхронизации, слой не 0).
    $mpeg = $at(0, 'ID3') || ($b0 === 0xFF && ($b1 & 0xE0) === 0xE0 && (($b1 >> 1) & 3) !== 0);
    // AAC в ADTS: синхрослово 0xFFF, слой 0.
    $adts = $b0 === 0xFF && ($b1 & 0xF6) === 0xF0;
    $ftyp = $at(4, 'ftyp');
    $ebml = $at(0, "\x1A\x45\xDF\xA3");
    $zip = $at(0, "PK\x03\x04") || $at(0, "PK\x05\x06");
    $json = ltrim($head) !== '' && ltrim($head)[0] === '{';
    return match ($ext) {
        'scraftz' => $zip,
        'scraft' => $json,
        'wav', 'wave', 'bwf', 'rf64' => $riff,
        'aif', 'aiff', 'aifc' => $aiff,
        'flac' => $at(0, 'fLaC') || ($at(0, 'ID3') && str_contains($head, 'fLaC')),
        'mp3', 'mp2' => $mpeg,
        'ogg', 'oga', 'opus' => $at(0, 'OggS'),
        'm4a', 'm4b', 'mp4' => $ftyp,
        'aac' => $adts || $at(0, 'ID3'),
        'ac3' => $b0 === 0x0B && $b1 === 0x77,
        'caf' => $at(0, 'caff'),
        'mka', 'webm' => $ebml,
        'mid', 'midi' => $at(0, 'MThd') || ($at(0, 'RIFF') && $at(8, 'RMID')),
        default => false,
    };
}

/** Расширение документа по имени, в нижнем регистре ('' — неизвестное). */
function files_ext(string $name): string
{
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    return in_array($ext, FILES_EXTS, true) ? $ext : '';
}

/** Имя файла, как его видит пользователь: без путей и служебных символов. */
function files_name(?string $name): string
{
    $name = trim((string)$name);
    $name = preg_replace('/[\x00-\x1F\x7F\/\\\\]+/u', ' ', $name) ?? '';
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    if ($name === '' || $name === '.' || $name === '..') {
        files_fail(400, 'Пустое имя файла.');
    }
    if (mb_strlen($name) > 120) {
        $name = mb_substr($name, 0, 120);
    }
    // Файл без известного расширения — проект в родном формате.
    if (files_ext($name) === '') {
        $name .= '.scraftz';
    }
    return $name;
}

/** Список файлов пользователя под блокировкой: $fn меняет его и возвращает результат. */
function files_index(string $dir, callable $fn)
{
    $lock = fopen("$dir/index.lock", 'c');
    if ($lock === false) {
        files_fail(500, 'Не удалось открыть список файлов.');
    }
    flock($lock, LOCK_EX);
    try {
        $raw = is_file("$dir/index.json") ? file_get_contents("$dir/index.json") : '';
        $index = $raw ? json_decode($raw, true) : [];
        if (!is_array($index)) {
            $index = [];
        }
        $before = $index;
        $result = $fn($index);
        if ($index !== $before) {
            $tmp = "$dir/index.json." . bin2hex(random_bytes(4));
            file_put_contents($tmp, json_encode($index, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            rename($tmp, "$dir/index.json");
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function files_json_body(): array
{
    $j = json_decode((string)file_get_contents('php://input'), true);
    return is_array($j) ? $j : [];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = (string)($_GET['action'] ?? ($method === 'GET' ? 'list' : ''));

switch ($action) {
    case 'list':
        $files = files_index($dir, static function (array &$index): array {
            $out = [];
            foreach ($index as $name => $f) {
                $out[] = ['name' => (string)$name, 'size' => (int)($f['size'] ?? 0), 'modified' => (int)($f['modified'] ?? 0)];
            }
            usort($out, static fn($a, $b) => $b['modified'] <=> $a['modified']);
            return $out;
        });
        files_ok(['user' => $user, 'files' => $files, 'limit' => FILES_MAX_BYTES]);

    case 'load':
        $name = files_name($_GET['name'] ?? '');
        $file = files_index($dir, static fn(array &$index) => $index[$name]['file'] ?? null);
        if (!is_string($file) || !preg_match(FILES_STORED, $file) || !is_file("$dir/$file")) {
            files_fail(404, "Файла «{$name}» нет.");
        }
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . filesize("$dir/$file"));
        readfile("$dir/$file");
        exit;

    case 'save':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $name = files_name($_GET['name'] ?? '');
        $overwrite = ($_GET['overwrite'] ?? '') === '1';
        $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($declared > FILES_MAX_BYTES) {
            files_fail(413, 'Файл больше ' . FILES_MAX_MB . ' МБ (предел сервера: AI_AUDITION_MAX_MB).');
        }
        $tmp = "$dir/upload." . bin2hex(random_bytes(6));
        $in = fopen('php://input', 'rb');
        $out = fopen($tmp, 'wb');
        $size = ($in && $out) ? stream_copy_to_stream($in, $out, FILES_MAX_BYTES + 1) : false;
        if ($in) fclose($in);
        if ($out) fclose($out);
        if ($size === false || $size === 0) {
            @unlink($tmp);
            files_fail(400, $declared > 0
                ? 'Сервер не передал PHP содержимое файла. Скорее всего, файл больше post_max_size в настройках PHP — увеличьте post_max_size и upload_max_filesize.'
                : 'Пустой файл.');
        }
        if ($size > FILES_MAX_BYTES) {
            @unlink($tmp);
            files_fail(413, 'Файл больше ' . FILES_MAX_MB . ' МБ (предел сервера: AI_AUDITION_MAX_MB).');
        }
        // Содержимое должно быть тем, что обещает расширение (по первым байтам).
        $ext = files_ext($name);
        $head = (string)file_get_contents($tmp, false, null, 0, 4096);
        if (!files_magic_ok($ext, $head)) {
            @unlink($tmp);
            files_fail(400, 'Содержимое не похоже на файл .' . $ext . '.');
        }
        $saved = files_index($dir, static function (array &$index) use ($dir, $name, $overwrite, $tmp, $size) {
            if (isset($index[$name]) && !$overwrite) {
                return ['exists' => true];
            }
            if (!isset($index[$name]) && count($index) >= FILES_MAX_COUNT) {
                return ['full' => true];
            }
            $old = (string)($index[$name]['file'] ?? '');
            $file = preg_match(FILES_STORED, $old) ? $old : (bin2hex(random_bytes(16)) . '.' . files_ext($name));
            if (!rename($tmp, "$dir/$file")) {
                return ['error' => true];
            }
            $index[$name] = ['file' => $file, 'size' => $size, 'modified' => time()];
            return ['modified' => $index[$name]['modified']];
        });
        if (!empty($saved['exists']) || !empty($saved['full']) || !empty($saved['error'])) {
            @unlink($tmp);
        }
        if (!empty($saved['exists'])) {
            files_fail(409, "Файл «{$name}» уже есть.", ['exists' => true]);
        }
        if (!empty($saved['full'])) {
            files_fail(507, 'Слишком много файлов. Удалите ненужные.');
        }
        if (!empty($saved['error'])) {
            files_fail(500, 'Не удалось записать файл на сервер. Проверьте права PHP на ' . $dir);
        }
        files_ok(['name' => $name, 'size' => $size, 'modified' => $saved['modified']]);

    case 'rename':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $body = files_json_body();
        $name = files_name($body['name'] ?? '');
        $to = files_name($body['to'] ?? '');
        $r = files_index($dir, static function (array &$index) use ($name, $to) {
            if (!isset($index[$name])) return 'missing';
            if ($name === $to) return 'ok';
            if (isset($index[$to])) return 'exists';
            $index[$to] = $index[$name];
            unset($index[$name]);
            return 'ok';
        });
        if ($r === 'missing') files_fail(404, "Файла «{$name}» нет.");
        if ($r === 'exists') files_fail(409, "Файл «{$to}» уже есть.", ['exists' => true]);
        files_ok(['name' => $to]);

    case 'delete':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $name = files_name(files_json_body()['name'] ?? '');
        $r = files_index($dir, static function (array &$index) use ($dir, $name) {
            if (!isset($index[$name])) return false;
            $file = (string)($index[$name]['file'] ?? '');
            if (preg_match(FILES_STORED, $file) && is_file("$dir/$file")) {
                @mkdir("$dir/.trash", 0770);
                @rename("$dir/$file", "$dir/.trash/" . date('Ymd-His') . '-' . $file);
            }
            unset($index[$name]);
            return true;
        });
        if (!$r) files_fail(404, "Файла «{$name}» нет.");
        files_ok([]);

    default:
        files_fail(400, 'Неизвестное действие.');
}
