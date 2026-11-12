use std::path::{Path, PathBuf};

/// Host services (file dialogs) injected by the app; absent in tests and on the web. They return
/// paths as picked: the caller converts one to text where a command takes it ([`crate::dialogs::unicode`]).
#[derive(Default)]
pub struct Services {
    pub pick_open: Option<Box<dyn Fn(&str, &[&str]) -> Option<PathBuf>>>,
    /// The purpose and the file to start from.
    pub pick_save: Option<Box<dyn Fn(&str, &Path) -> Option<PathBuf>>>,
    /// The folder to start in.
    pub pick_folder: Option<Box<dyn Fn(&Path) -> Option<PathBuf>>>,
    /// Web (AI-Audition): leave the editor for the site it lives on (`STUDIO_CONFIG.homeUrl`). The
    /// menu bar shows a house at its right end when set, and hides the desktop-only items.
    pub go_home: Option<Box<dyn Fn()>>,
    /// Web (AI-Audition): the AI chip in the menu bar opens the page's AI menu at this point of
    /// the window (egui points): names of tracks, clips and markers, comments.
    pub ai_assist: Option<Box<dyn Fn(f32, f32)>>,
}
