//! AI-Audition: the interface in Russian.
//!
//! SoundCraft's interface strings are English literals with no catalogue, so the browser build
//! translates them where egui lays text out: [`install`] hands [`translate`] to egui's text
//! translator hook (`vendor/egui`, `egui::set_text_translator`). Every plain text a widget, window
//! title, menu or tooltip is given, and every text painted with `Painter::text`, passes through
//! it; text edits (what the user types) are never touched.
//!
//! The table is `ru.tsv` (English, a tab, Russian; `#` starts a comment line). A string is
//! translated when it is in the table exactly, or when it is a known string followed by `...`,
//! `…` or `:`, or a menu path (`A > B > C`) whose every part is known. Anything else is shown as
//! it is, so a missing row costs only an English word, never a wrong one.

use std::collections::HashMap;
use std::sync::OnceLock;

/// English → Russian, one pair per line.
const TABLE: &str = include_str!("ru.tsv");

/// The longest text looked up: longer texts are names and messages, not interface strings.
const MAX_LOOKUP: usize = 200;

fn table() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        TABLE
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
            .filter_map(|l| l.split_once('\t'))
            .map(|(en, ru)| (en, ru.trim_end()))
            .filter(|(en, ru)| !en.is_empty() && !ru.is_empty())
            .collect()
    })
}

static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Install the translator (once, at start-up of the browser build).
pub fn install() {
    INSTALLED.store(true, std::sync::atomic::Ordering::Relaxed);
    egui::set_text_translator(translate);
}

/// `text` in the interface language: its Russian once [`install`] ran, else unchanged. For a word
/// that becomes part of a longer, formatted string (which the hook can't match whole).
pub fn word(text: &str) -> String {
    if INSTALLED.load(std::sync::atomic::Ordering::Relaxed) {
        return translate(text).unwrap_or_else(|| text.to_string());
    }
    text.to_string()
}

/// The Russian for an interface string, or `None` to keep it.
pub fn translate(text: &str) -> Option<String> {
    if text.len() > MAX_LOOKUP || !text.bytes().any(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let map = table();
    if let Some(ru) = map.get(text) {
        return Some((*ru).to_string());
    }
    // "Bounce Mix..." / "Bounce Mix…" / "Name:" from "Bounce Mix" / "Name".
    for (suffix, shown) in [("...", "…"), ("…", "…"), (":", ":")] {
        if let Some(base) = text.strip_suffix(suffix)
            && let Some(ru) = map.get(base.trim_end())
        {
            return Some(format!("{ru}{shown}"));
        }
    }
    // A menu path, part by part.
    if text.contains(" > ") {
        let parts: Vec<String> = text.split(" > ").map(|p| translate(p).unwrap_or_else(|| p.to_string())).collect();
        let joined = parts.join(" › ");
        return (joined != text).then_some(joined);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_rows_are_well_formed() {
        for (n, line) in TABLE.lines().enumerate() {
            if line.trim().is_empty() || line.starts_with('#') {
                continue;
            }
            let (en, ru) = line.split_once('\t').unwrap_or_else(|| panic!("ru.tsv:{}: no tab", n + 1));
            assert!(!en.is_empty() && !ru.trim().is_empty(), "ru.tsv:{}: empty side", n + 1);
            assert!(!ru.contains('\t'), "ru.tsv:{}: two tabs", n + 1);
        }
    }

    #[test]
    fn exact_suffixed_and_menu_paths_translate() {
        assert_eq!(translate("Edit").as_deref(), Some("Правка"));
        assert_eq!(translate("Bounce Mix...").as_deref(), Some("Свести микс…"));
        assert_eq!(translate("File > Bounce Mix...").as_deref(), Some("Файл › Свести микс…"));
        assert_eq!(translate("Kick Drum 7"), None);
        assert_eq!(translate("123"), None);
    }
}
