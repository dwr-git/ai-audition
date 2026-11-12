//! Design tokens. Colours were chosen by eye to give a dark, studio-style look; they are ours.
//!
//! AI-Audition: Light and Dark are our neumorphic palettes (NeuLight, NeuDark), and the Brand
//! theme (navy chrome, the brand's blue-violet accent, solid black menus and windows with a
//! strong shadow, the brand backdrop behind the tracks) is the browser build's default.

use egui::{Color32, FontFamily, FontId};
use std::sync::atomic::{AtomicU8, Ordering};

/// The active palette ([`Palette`] as a number). Dark is the default (the incumbent is dark-only).
static PALETTE: AtomicU8 = AtomicU8::new(0);

/// The palette the custom-painted UI uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Palette {
    Dark,
    Light,
    Brand,
}

impl Palette {
    const fn code(self) -> u8 {
        match self {
            Self::Dark => 0,
            Self::Light => 1,
            Self::Brand => 2,
        }
    }

    fn from_code(c: u8) -> Self {
        match c {
            1 => Self::Light,
            2 => Self::Brand,
            _ => Self::Dark,
        }
    }
}

/// Unit tests that change or read the process-wide palette must own it until their assertions
/// finish. The lock is re-entrant per thread, so a test may hold it and still build apps
/// (`SoundApp::new` takes it too) without deadlocking itself.
#[cfg(test)]
pub(crate) fn lock_test_palette() -> TestPaletteGuard {
    TestPaletteGuard::acquire()
}

/// RAII handle for the re-entrant, per-thread test palette lock; see [`lock_test_palette`].
#[cfg(test)]
pub(crate) struct TestPaletteGuard;

#[cfg(test)]
impl TestPaletteGuard {
    fn acquire() -> Self {
        palette_lock::acquire();
        Self
    }
}

#[cfg(test)]
impl Drop for TestPaletteGuard {
    fn drop(&mut self) {
        palette_lock::release();
    }
}

#[cfg(test)]
mod palette_lock {
    use std::cell::{Cell, RefCell};
    use std::sync::{Mutex, MutexGuard, PoisonError};

    static PALETTE: Mutex<()> = Mutex::new(());

    thread_local! {
        /// How many guards this thread holds; the OS lock is taken on 0→1 and released on 1→0.
        static DEPTH: Cell<usize> = const { Cell::new(0) };
        static GUARD: RefCell<Option<MutexGuard<'static, ()>>> = const { RefCell::new(None) };
    }

    pub(super) fn acquire() {
        DEPTH.with(|depth| {
            if depth.get() == 0 {
                GUARD.with(|guard| *guard.borrow_mut() = Some(PALETTE.lock().unwrap_or_else(PoisonError::into_inner)));
            }
            depth.set(depth.get() + 1);
        });
    }

    pub(super) fn release() {
        DEPTH.with(|depth| {
            let left = depth.get().saturating_sub(1);
            depth.set(left);
            if left == 0 {
                GUARD.with(|guard| *guard.borrow_mut() = None);
            }
        });
    }
}

/// The Appearance setting (`ui.theme {mode}`). Dark by default; System and Light are opt-in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    System,
    Light,
    #[default]
    Dark,
    /// AI-Audition's Brand theme (the browser build starts in it).
    Brand,
}

impl ThemeMode {
    pub const ALL: [Self; 4] = [Self::Brand, Self::Dark, Self::Light, Self::System];

    pub const fn label(self) -> &'static str {
        match self {
            Self::System => "System",
            Self::Light => "Light",
            Self::Dark => "Dark",
            Self::Brand => "Brand",
        }
    }

    /// The id used in `ui.theme {"mode": …}` and in the saved UI prefs.
    pub const fn id(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
            Self::Brand => "brand",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.id().eq_ignore_ascii_case(s.trim()))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tokens {
    pub window_bg: Color32,
    pub panel_bg: Color32,
    pub panel_bg2: Color32,
    pub toolbar_bg: Color32,
    pub toolbar_group: Color32,
    pub border: Color32,
    pub border_light: Color32,
    /// The lit top/left edge of raised panels: track headers and Mix strips.
    pub edge_light: Color32,
    pub text: Color32,
    pub text_dim: Color32,
    pub text_dark: Color32,
    pub header_text: Color32,
    pub counter_bg: Color32,
    pub counter_text: Color32,
    pub counter_label: Color32,
    pub accent: Color32,
    pub accent_dark: Color32,
    pub mode_on: Color32,
    pub mode_on_text: Color32,
    pub mode_off_text: Color32,
    pub button: Color32,
    pub button_hi: Color32,
    pub button_border: Color32,
    pub name_field: Color32,
    pub name_field_sel: Color32,
    pub ruler_bg: Color32,
    pub ruler_label_bg: Color32,
    pub ruler_text: Color32,
    pub ruler_tick: Color32,
    pub tempo_ruler: Color32,
    pub meter_ruler: Color32,
    pub marker_ruler: Color32,
    pub playlist_bg: Color32,
    pub playlist_alt: Color32,
    pub grid_line: Color32,
    pub bar_line: Color32,
    pub selection: Color32,
    pub playhead: Color32,
    pub insertion: Color32,
    pub solo: Color32,
    pub mute: Color32,
    pub rec: Color32,
    pub input: Color32,
    pub auto_read: Color32,
    pub auto_write: Color32,
    pub auto_touch: Color32,
    pub auto_latch: Color32,
    pub meter_green: Color32,
    pub meter_yellow: Color32,
    pub meter_red: Color32,
    pub fader_track: Color32,
    pub strip_bg: Color32,
    pub strip_section: Color32,
    pub slot_bg: Color32,
    pub automation_line: Color32,
    /// Menu bar background.
    pub menu_bar: Color32,
    /// Outline of toolbar groups.
    pub group_border: Color32,
    /// Edit-mode cell, not selected.
    pub mode_off: Color32,
    /// Counter-panel toggle (Grid, Count Off), off.
    pub counter_off: Color32,
    /// Outline of the counter panels.
    pub counter_border: Color32,
    /// Divider inside the counter panels.
    pub counter_rule: Color32,
    /// Smart-tool bracket, off.
    pub tool_bracket_off: Color32,
    /// Selected row in the Tracks, Groups and Clips lists.
    pub row_selected: Color32,
    /// Track-visible dot in the Tracks list.
    pub visible_dot: Color32,
    /// Big Counter background.
    pub big_counter_bg: Color32,
    /// Edit-window track header, selected.
    pub header_selected: Color32,
    /// Mix-window strip, selected.
    pub strip_selected: Color32,
    /// Marker names on the marker ruler.
    pub marker_text: Color32,
    /// Alternate-playlist lanes.
    pub playlist_lane: Color32,
    /// Universe overview background.
    pub universe_bg: Color32,
    /// Universe visible-area outline.
    pub universe_view: Color32,
    /// Meter background.
    pub meter_bg: Color32,
    /// Meter clip indicator, not clipped.
    pub meter_clip_off: Color32,
    /// Pan knob body.
    pub knob_bg: Color32,
    /// Pan knob outline.
    pub knob_ring: Color32,
    /// Pan knob pointer.
    pub knob_pointer: Color32,
    /// Mix-window section captions (INSERTS A-E, I/O…).
    pub section_label: Color32,
    /// Plugin slots, as Pro Tools draws them: the well they sit in, an empty slot, a used slot's
    /// face (top, bottom), a bypassed one's, and the dots, letters and arrows on them.
    pub slot_well: Color32,
    pub slot_empty: Color32,
    pub slot_face: [Color32; 2],
    pub slot_bypassed: [Color32; 2],
    pub slot_mark: Color32,
}

impl Tokens {
    pub const DARK: Tokens = Tokens {
        window_bg: hex(0x1b202a),
        panel_bg: hex(0x262d3a),
        panel_bg2: hex(0x282f3d),
        toolbar_bg: hex(0x262d3a),
        toolbar_group: hex(0x202632),
        border: hex(0x161b24),
        border_light: hex(0x3b4558),
        edge_light: Color32::from_rgba_premultiplied(20, 20, 20, 20),
        text: hex(0xc4cfe0),
        text_dim: hex(0xa0adc2),
        text_dark: Color32::from_rgb(16, 16, 16),
        header_text: hex(0xe4ebf6),
        counter_bg: Color32::from_rgb(4, 4, 4),
        counter_text: Color32::from_rgb(104, 220, 120),
        counter_label: Color32::from_rgb(200, 200, 200),
        accent: hex(0x5ca8ff),
        accent_dark: hex(0x3d86d6),
        mode_on: Color32::from_rgb(92, 196, 108),
        mode_on_text: Color32::from_rgb(10, 30, 12),
        mode_off_text: Color32::from_rgb(98, 196, 112),
        button: hex(0x2d3544),
        button_hi: hex(0x364052),
        button_border: hex(0x1c222c),
        name_field: Color32::from_rgb(208, 208, 208),
        name_field_sel: Color32::from_rgb(232, 232, 232),
        ruler_bg: hex(0x222834),
        ruler_label_bg: hex(0x222834),
        ruler_text: hex(0xc4cfe0),
        ruler_tick: hex(0x5d687c),
        tempo_ruler: Color32::from_rgb(52, 128, 88),
        meter_ruler: Color32::from_rgb(44, 108, 140),
        marker_ruler: hex(0x262d3a),
        playlist_bg: hex(0x202632),
        playlist_alt: hex(0x252c39),
        grid_line: hex(0x2b3342),
        bar_line: hex(0x3a4456),
        selection: Color32::from_rgba_premultiplied(37, 67, 102, 102),
        playhead: Color32::from_rgb(232, 60, 50),
        insertion: Color32::from_rgb(230, 230, 230),
        solo: Color32::from_rgb(222, 196, 52),
        mute: Color32::from_rgb(232, 148, 40),
        rec: Color32::from_rgb(214, 52, 46),
        input: Color32::from_rgb(70, 170, 90),
        auto_read: Color32::from_rgb(96, 200, 110),
        auto_write: Color32::from_rgb(220, 70, 60),
        auto_touch: Color32::from_rgb(230, 170, 50),
        auto_latch: Color32::from_rgb(160, 120, 220),
        meter_green: Color32::from_rgb(60, 200, 80),
        meter_yellow: Color32::from_rgb(230, 210, 60),
        meter_red: Color32::from_rgb(230, 50, 40),
        fader_track: Color32::from_rgb(12, 12, 12),
        strip_bg: hex(0x282f3d),
        strip_section: hex(0x222834),
        slot_bg: hex(0x1e2430),
        automation_line: Color32::from_rgb(240, 240, 240),
        menu_bar: hex(0x262d3a),
        group_border: hex(0x1c222c),
        mode_off: Color32::from_rgb(20, 36, 22),
        counter_off: Color32::from_rgb(30, 50, 32),
        counter_border: hex(0x3b4558),
        counter_rule: Color32::from_rgb(40, 40, 40),
        tool_bracket_off: hex(0x3b4558),
        row_selected: hex(0x2c4a6e),
        visible_dot: Color32::from_rgb(200, 200, 200),
        big_counter_bg: Color32::from_rgb(0, 0, 0),
        header_selected: hex(0x2f3a4d),
        strip_selected: hex(0x2f3a4d),
        marker_text: Color32::from_rgb(236, 236, 236),
        playlist_lane: hex(0x1e2430),
        universe_bg: hex(0x1b202a),
        universe_view: Color32::from_rgb(255, 255, 255),
        meter_bg: Color32::from_rgb(8, 8, 8),
        meter_clip_off: Color32::from_rgb(60, 20, 20),
        knob_bg: hex(0x1e2430),
        knob_ring: Color32::from_rgb(150, 150, 154),
        knob_pointer: Color32::from_rgb(230, 230, 230),
        section_label: hex(0xc4cfe0),
        slot_well: hex(0x222834),
        slot_empty: hex(0x262d3a),
        slot_face: [Color32::from_rgb(92, 92, 92), Color32::from_rgb(75, 75, 75)],
        slot_bypassed: [Color32::from_rgb(66, 96, 146), Color32::from_rgb(50, 76, 120)],
        slot_mark: Color32::from_rgb(159, 159, 159),
    };

    pub const LIGHT: Tokens = Tokens {
        window_bg: hex(0xd6e0ed),
        panel_bg: hex(0xe4ecf6),
        panel_bg2: hex(0xe6eef8),
        toolbar_bg: hex(0xe4ecf6),
        toolbar_group: hex(0xdce6f3),
        border: hex(0xb3c2d6),
        border_light: hex(0xc9d5e5),
        edge_light: Color32::from_rgba_premultiplied(150, 150, 150, 150),
        text: hex(0x34445e),
        text_dim: hex(0x4e5e78),
        text_dark: hex(0x1e2c42),
        header_text: hex(0x1e2c42),
        counter_bg: hex(0xf3f7fc),
        counter_text: Color32::from_rgb(18, 108, 40),
        counter_label: Color32::from_rgb(54, 57, 63),
        accent: hex(0x3480e2),
        accent_dark: hex(0x1652a8),
        mode_on: Color32::from_rgb(75, 158, 88),
        mode_on_text: Color32::from_rgb(255, 255, 255),
        mode_off_text: Color32::from_rgb(38, 106, 52),
        button: hex(0xe6eef8),
        button_hi: hex(0xd5e0ee),
        button_border: hex(0xb3c2d6),
        name_field: hex(0xf3f7fc),
        name_field_sel: hex(0xd8e6f8),
        ruler_bg: hex(0xe9f0f8),
        ruler_label_bg: hex(0xe9f0f8),
        ruler_text: hex(0x34445e),
        ruler_tick: hex(0x8d9ab0),
        tempo_ruler: Color32::from_rgb(92, 156, 112),
        meter_ruler: Color32::from_rgb(80, 144, 172),
        marker_ruler: hex(0xdce6f3),
        playlist_bg: hex(0xe6eef8),
        playlist_alt: hex(0xdde7f3),
        grid_line: hex(0xcdd8e7),
        bar_line: hex(0xb3c2d6),
        selection: Color32::from_rgba_premultiplied(30, 72, 128, 85),
        playhead: Color32::from_rgb(210, 48, 42),
        insertion: Color32::from_rgb(35, 36, 40),
        solo: Color32::from_rgb(178, 145, 20),
        mute: Color32::from_rgb(194, 106, 22),
        rec: Color32::from_rgb(190, 42, 38),
        input: Color32::from_rgb(45, 126, 64),
        auto_read: Color32::from_rgb(52, 142, 68),
        auto_write: Color32::from_rgb(190, 50, 45),
        auto_touch: Color32::from_rgb(180, 122, 24),
        auto_latch: Color32::from_rgb(118, 80, 170),
        meter_green: Color32::from_rgb(36, 160, 58),
        meter_yellow: Color32::from_rgb(190, 162, 20),
        meter_red: Color32::from_rgb(195, 42, 35),
        fader_track: Color32::from_rgb(120, 123, 129),
        strip_bg: hex(0xe6eef8),
        strip_section: hex(0xdce6f3),
        slot_bg: hex(0xdce6f3),
        automation_line: hex(0x1e2c42),
        menu_bar: hex(0xe4ecf6),
        group_border: hex(0xb3c2d6),
        mode_off: Color32::from_rgb(202, 212, 204),
        counter_off: Color32::from_rgb(192, 212, 198),
        counter_border: hex(0xb3c2d6),
        counter_rule: Color32::from_rgb(188, 191, 196),
        tool_bracket_off: hex(0xb3c2d6),
        row_selected: hex(0xc2d8f5),
        visible_dot: hex(0x4e5e78),
        big_counter_bg: hex(0xf3f7fc),
        header_selected: hex(0xcfe0f6),
        strip_selected: hex(0xcfe0f6),
        marker_text: hex(0x1e2c42),
        playlist_lane: hex(0xdce6f3),
        universe_bg: hex(0xdce6f3),
        universe_view: hex(0x1e2c42),
        meter_bg: Color32::from_rgb(52, 54, 58),
        meter_clip_off: Color32::from_rgb(92, 54, 54),
        knob_bg: hex(0xf3f7fc),
        knob_ring: Color32::from_rgb(116, 120, 128),
        knob_pointer: Color32::from_rgb(30, 32, 38),
        section_label: hex(0x34445e),
        slot_well: hex(0xdce6f3),
        slot_empty: hex(0xd3dfee),
        slot_face: [Color32::from_rgb(244, 245, 247), Color32::from_rgb(214, 216, 220)],
        slot_bypassed: [Color32::from_rgb(190, 210, 240), Color32::from_rgb(160, 186, 228)],
        slot_mark: Color32::from_rgb(92, 95, 102),
    };

    /// The Brand theme: the brand gradient's navy (#0a0a0f → #1a1a2e → #16213e) for the chrome,
    /// the brand's blue-violet (#667eea) for the accent; `window_bg` is [`BRAND_CANVAS`], so the
    /// area behind the tracks gets the brand backdrop ([`paint_canvas_fill`]).
    pub const BRAND: Tokens = Tokens {
        window_bg: BRAND_CANVAS,
        panel_bg: hex(0x111222),
        panel_bg2: hex(0x16182a),
        toolbar_bg: hex(0x0c0d17),
        toolbar_group: hex(0x16182a),
        border: hex(0x05050a),
        border_light: hex(0x2a2d46),
        text: hex(0xeef0ff),
        text_dim: hex(0xb7bbd8),
        header_text: hex(0xffffff),
        accent: hex(0x667eea),
        accent_dark: hex(0x5468d4),
        button: hex(0x1f2238),
        button_hi: hex(0x2a2e4c),
        button_border: hex(0x05050a),
        ruler_bg: hex(0x12131f),
        ruler_label_bg: hex(0x12131f),
        ruler_text: hex(0xd8dbf0),
        ruler_tick: hex(0x5b5f84),
        marker_ruler: hex(0x16182a),
        playlist_bg: hex(0x14162a),
        playlist_alt: hex(0x191c33),
        grid_line: hex(0x232640),
        bar_line: hex(0x30345a),
        selection: Color32::from_rgba_premultiplied(56, 69, 128, 136),
        strip_bg: hex(0x16182a),
        strip_section: hex(0x111222),
        slot_bg: hex(0x0c0d17),
        menu_bar: hex(0x0c0d17),
        group_border: hex(0x05050a),
        row_selected: hex(0x2a3066),
        header_selected: hex(0x232852),
        strip_selected: hex(0x232852),
        playlist_lane: hex(0x111222),
        universe_bg: hex(0x0c0d17),
        slot_well: hex(0x12131f),
        slot_empty: hex(0x16182a),
        counter_border: hex(0x2a2d46),
        tool_bracket_off: hex(0x2a2d46),
        knob_bg: hex(0x111222),
        section_label: hex(0xd8dbf0),
        ..Tokens::DARK
    };

    pub fn current() -> Tokens {
        match palette() {
            Palette::Dark => Self::DARK,
            Palette::Light => Self::LIGHT,
            Palette::Brand => Self::BRAND,
        }
    }

    /// Text and marks drawn on `accent` (dark on the Dark theme's light blue, white elsewhere).
    pub fn accent_text_on(&self) -> Color32 {
        if self.accent == Self::DARK.accent { hex(0x0b1220) } else { Color32::WHITE }
    }
}

const fn hex(rgb: u32) -> Color32 {
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

/// The colour the Brand backdrop reads as: `window_bg` in the Brand theme.
pub const BRAND_CANVAS: Color32 = Color32::from_rgb(0x16, 0x18, 0x2C);

/// The active palette.
pub fn palette() -> Palette {
    Palette::from_code(PALETTE.load(Ordering::Relaxed))
}

/// The palette for a mode this frame: Brand for Brand, else Light or Dark as [`wants_light`] says.
pub fn wants_palette(ctx: &egui::Context, mode: ThemeMode) -> Palette {
    match mode {
        ThemeMode::Brand => Palette::Brand,
        _ if wants_light(ctx, mode) => Palette::Light,
        _ => Palette::Dark,
    }
}

/// Whether the Light palette is the active one.
pub fn is_light() -> bool {
    palette() == Palette::Light
}

/// Resolve each frame from the integration's current OS appearance, or on Linux the desktop's own
/// setting when egui reports none. Unknown uses Dark.
pub fn wants_light(ctx: &egui::Context, mode: ThemeMode) -> bool {
    match mode {
        ThemeMode::Light => true,
        ThemeMode::Dark | ThemeMode::Brand => false,
        ThemeMode::System => crate::appearance::resolve(ctx.system_theme(), || crate::appearance::desktop_theme(ctx)) == Some(egui::Theme::Light),
    }
}

/// A track's header and lane backgrounds in the Edit window, tinted with its colour by `tint` (0..1).
pub fn track_backgrounds(color: [u8; 3], selected: bool, tint: f32) -> (Color32, Color32) {
    let t = Tokens::current();
    let k = tint.clamp(0.0, 1.0);
    if k <= 0.0 {
        return if selected { (t.header_selected, t.playlist_alt) } else { (t.panel_bg2, t.playlist_bg) };
    }
    let c = rgb(color);
    let header = t.panel_bg2.lerp_to_gamma(c, k * 0.55);
    let header = if selected { crate::widgets::shade(header, 0.1) } else { header };
    let lane = if selected { t.playlist_alt } else { t.playlist_bg }.lerp_to_gamma(c, k * 0.2);
    (header, lane)
}

/// Track colours tinted for clip bodies.
pub fn clip_colors(rgb: [u8; 3], selected: bool) -> (Color32, Color32, Color32) {
    let [r, g, b] = rgb;
    let shade = |k: f32| Color32::from_rgb((f32::from(r) * k) as u8, (f32::from(g) * k) as u8, (f32::from(b) * k) as u8);
    let tint = |k: f32| {
        let t = |c: u8| (f32::from(c) + (255.0 - f32::from(c)) * k) as u8;
        Color32::from_rgb(t(r), t(g), t(b))
    };
    let bar = shade(0.9);
    if is_light() {
        // A paler body and a waveform in a deep shade of the clip's own colour.
        return if selected { (tint(0.2), bar, shade(0.22)) } else { (tint(0.45), bar, shade(0.32)) };
    }
    // A dark body and a light waveform in the clip's own colour; selection inverts them.
    if selected { (shade(0.7), bar, Color32::from_rgb(16, 16, 18)) } else { (shade(0.34), bar, tint(0.35)) }
}

pub fn rgb(c: [u8; 3]) -> Color32 {
    Color32::from_rgb(c[0], c[1], c[2])
}

pub fn bold(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name("bold".into()))
}

pub fn regular(size: f32) -> FontId {
    FontId::new(size, FontFamily::Proportional)
}

pub fn mono(size: f32) -> FontId {
    FontId::new(size, FontFamily::Monospace)
}

/// Make `light` (or dark) the active palette and apply its visuals. Call only when it changes.
pub fn apply(ctx: &egui::Context, light: bool) {
    apply_palette(ctx, if light { Palette::Light } else { Palette::Dark });
}

/// Make `p` the active palette and apply its visuals. Call only when it changes.
pub fn apply_palette(ctx: &egui::Context, p: Palette) {
    PALETTE.store(p.code(), Ordering::Relaxed);
    let light = p == Palette::Light;
    let t = Tokens::current();
    let mut v = if light { egui::Visuals::light() } else { egui::Visuals::dark() };
    v.panel_fill = t.panel_bg;
    v.window_fill = t.panel_bg2;
    v.extreme_bg_color = t.slot_bg;
    v.faint_bg_color = t.panel_bg2;
    v.selection.bg_fill = t.accent;
    v.widgets.inactive.weak_bg_fill = t.button;
    v.widgets.inactive.bg_fill = t.button;
    v.widgets.hovered.weak_bg_fill = t.button_hi;
    v.widgets.noninteractive.fg_stroke.color = t.text;
    v.widgets.inactive.fg_stroke.color = t.text;
    v.window_corner_radius = egui::CornerRadius::same(6);
    v.menu_corner_radius = egui::CornerRadius::same(4);
    match p {
        // Neumorphic Light and Dark: rounded windows and menus, soft shadows tinted with the
        // palette's blue instead of grey.
        Palette::Light | Palette::Dark => {
            let shade = if light { Color32::from_rgba_unmultiplied(0x46, 0x5a, 0x82, 70) } else { Color32::from_black_alpha(150) };
            v.window_corner_radius = egui::CornerRadius::same(10);
            v.menu_corner_radius = egui::CornerRadius::same(8);
            v.popup_shadow = egui::epaint::Shadow { offset: [0, 6], blur: 18, spread: 0, color: shade };
            v.window_shadow = egui::epaint::Shadow { offset: [0, 10], blur: 30, spread: 0, color: shade };
            v.selection.bg_fill = if light { Color32::from_rgb(0x34, 0x80, 0xe2) } else { Color32::from_rgb(0x2c, 0x6c, 0xb8) };
            v.hyperlink_color = if light { hex(0x1652a8) } else { hex(0x8ec6ff) };
        }
        // Brand: menus, popups and windows are solid black blocks with a strong black shadow.
        Palette::Brand => {
            v.window_fill = Color32::BLACK;
            v.window_stroke = egui::Stroke::new(1.0, hex(0x26283c));
            v.window_corner_radius = egui::CornerRadius::same(8);
            v.menu_corner_radius = egui::CornerRadius::same(6);
            v.popup_shadow = egui::epaint::Shadow { offset: [0, 8], blur: 32, spread: 0, color: Color32::BLACK };
            v.window_shadow = egui::epaint::Shadow { offset: [0, 10], blur: 36, spread: 2, color: Color32::BLACK };
            v.hyperlink_color = hex(0xa9b4ff);
        }
    }
    // Keep receiving native OS appearance changes even when our palette is manual. On macOS,
    // pinning egui's theme also pins the window appearance and hides later OS changes.
    ctx.set_theme(egui::ThemePreference::System);
    // Both egui style branches must use our resolved palette: egui can select either branch
    // as the OS changes, including while SoundCraft's manual Light/Dark choice stays fixed.
    ctx.all_styles_mut(|s| {
        s.visuals = v.clone();
        s.spacing.item_spacing = egui::vec2(6.0, 4.0);
        s.spacing.button_padding = egui::vec2(6.0, 2.0);
        s.interaction.tooltip_delay = 0.4;
    });
}

/// The Brand theme's canvas backdrop, as the owner's page draws it in CSS: the brand gradient
/// (#0a0a0f → #1a1a2e → #16213e at 135°), three soft glows (circles at 20% 80%, 80% 20% and 40% 40%,
/// fading out halfway to the farthest corner), a 30 px grid of 5% white lines, and an inner shadow
/// (`inset 0 0 35px 10px #00000099`) round the edges.
pub fn paint_brand_backdrop(painter: &egui::Painter, rect: egui::Rect) {
    use egui::epaint::{Mesh, Vertex, WHITE_UV};
    let vertex = |pos: egui::Pos2, color: Color32| Vertex { pos, uv: WHITE_UV, color };
    let quad = |m: &mut Mesh, corners: [(egui::Pos2, Color32); 4]| {
        let base = m.vertices.len() as u32;
        m.vertices.extend(corners.iter().map(|(p, c)| vertex(*p, *c)));
        m.indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    // The gradient: at 135° the top-left corner is the first stop, the bottom-right the last, and
    // the other two corners sit on the middle stop.
    let (a, mid, b) = (Color32::from_rgb(0x0A, 0x0A, 0x0F), Color32::from_rgb(0x1A, 0x1A, 0x2E), Color32::from_rgb(0x16, 0x21, 0x3E));
    let mut m = Mesh::default();
    quad(&mut m, [(rect.left_top(), a), (rect.right_top(), mid), (rect.right_bottom(), b), (rect.left_bottom(), mid)]);
    painter.add(egui::Shape::mesh(m));
    // The glows: a fan from the centre colour out to transparent at half the farthest-corner distance.
    for (fx, fy, rgb, alpha) in [(0.2_f32, 0.8_f32, (120, 119, 198), 0.30_f32), (0.8, 0.2, (255, 119, 198), 0.30), (0.4, 0.4, (120, 219, 255), 0.20)]
    {
        let c = rect.min + egui::vec2(rect.width() * fx, rect.height() * fy);
        let far = egui::vec2(rect.width() * fx.max(1.0 - fx), rect.height() * fy.max(1.0 - fy)).length();
        let reach = far * 0.5;
        let inner = Color32::from_rgba_unmultiplied(rgb.0, rgb.1, rgb.2, (alpha * 255.0) as u8);
        let mut g = Mesh::default();
        g.vertices.push(vertex(c, inner));
        const STEPS: u32 = 64;
        for i in 0..=STEPS {
            let angle = std::f32::consts::TAU * i as f32 / STEPS as f32;
            g.vertices.push(vertex(c + egui::vec2(angle.cos(), angle.sin()) * reach, Color32::TRANSPARENT));
        }
        for i in 1..=STEPS {
            g.indices.extend([0, i, i + 1]);
        }
        painter.add(egui::Shape::mesh(g));
    }
    // The grid: lines 30 points apart from the top-left corner.
    let line = egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 13));
    let mut x = rect.left() + 0.5;
    while x < rect.right() {
        painter.vline(x, rect.y_range(), line);
        x += 30.0;
    }
    let mut y = rect.top() + 0.5;
    while y < rect.bottom() {
        painter.hline(rect.x_range(), y, line);
        y += 30.0;
    }
    // The inner shadow: solid for the 10 px spread, then fading over the 35 px blur.
    let dark = |a: f32| Color32::from_rgba_unmultiplied(0, 0, 0, (a * 153.0) as u8);
    let mut sh = Mesh::default();
    for (from, to, a0, a1) in [(0.0_f32, 10.0_f32, 1.0_f32, 0.75_f32), (10.0, 45.0, 0.75, 0.0)] {
        let (r, i0, i1) = (rect, from, to);
        // top, bottom, left, right bands
        quad(
            &mut sh,
            [
                (egui::pos2(r.left(), r.top() + i0), dark(a0)),
                (egui::pos2(r.right(), r.top() + i0), dark(a0)),
                (egui::pos2(r.right(), r.top() + i1), dark(a1)),
                (egui::pos2(r.left(), r.top() + i1), dark(a1)),
            ],
        );
        quad(
            &mut sh,
            [
                (egui::pos2(r.left(), r.bottom() - i1), dark(a1)),
                (egui::pos2(r.right(), r.bottom() - i1), dark(a1)),
                (egui::pos2(r.right(), r.bottom() - i0), dark(a0)),
                (egui::pos2(r.left(), r.bottom() - i0), dark(a0)),
            ],
        );
        quad(
            &mut sh,
            [
                (egui::pos2(r.left() + i0, r.top()), dark(a0)),
                (egui::pos2(r.left() + i1, r.top()), dark(a1)),
                (egui::pos2(r.left() + i1, r.bottom()), dark(a1)),
                (egui::pos2(r.left() + i0, r.bottom()), dark(a0)),
            ],
        );
        quad(
            &mut sh,
            [
                (egui::pos2(r.right() - i1, r.top()), dark(a1)),
                (egui::pos2(r.right() - i0, r.top()), dark(a0)),
                (egui::pos2(r.right() - i0, r.bottom()), dark(a0)),
                (egui::pos2(r.right() - i1, r.bottom()), dark(a1)),
            ],
        );
    }
    painter.add(egui::Shape::mesh(sh));
}

/// The area behind the tracks: the brand backdrop in the Brand theme (`fill` is [`BRAND_CANVAS`]), else `fill`.
pub fn paint_canvas_fill(painter: &egui::Painter, rect: egui::Rect, fill: Color32) {
    if fill == BRAND_CANVAS {
        paint_brand_backdrop(painter, rect);
    } else {
        painter.rect_filled(rect, 0.0, fill);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Services, SoundApp, UiState};
    use serde_json::json;

    #[test]
    fn test_palette_lock_is_reentrant_and_excludes_other_threads() {
        // Regression for the parallel-run flakes: the process-wide palette must be owned for a
        // whole test, re-entrant on the owning thread (so `SoundApp::new` can take it too), and
        // exclusive against other threads (so a frame cannot flip it mid-test).
        let outer = lock_test_palette();
        let inner = lock_test_palette();
        let app = SoundApp::new(soundcraft_engine::Engine::default(), None, Services::default());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _held = lock_test_palette();
            let _ = tx.send(());
        });
        assert!(rx.recv_timeout(std::time::Duration::from_millis(100)).is_err(), "another thread must wait for the palette lock");
        drop(inner);
        drop(outer);
        drop(app);
        // Other tests compete for the lock too, and some hold it for seconds: allow for a queue.
        assert!(rx.recv_timeout(std::time::Duration::from_secs(120)).is_ok(), "the palette lock must be released when every holder drops it");
    }

    #[test]
    fn dark_is_the_default() {
        assert_eq!(ThemeMode::default(), ThemeMode::Dark);
        assert_eq!(UiState::default().theme, ThemeMode::Dark);
        // Prefs saved before the setting existed load as Dark.
        let old: UiState = serde_json::from_value(json!({"show_tracks_list": true})).unwrap_or_default();
        assert_eq!(old.theme, ThemeMode::Dark);
    }

    #[test]
    fn prefs_saved_before_track_tint_get_the_default() {
        let ui: UiState = serde_json::from_value(json!({"theme": "light"})).unwrap();
        assert!((ui.track_tint - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn modes_round_trip_through_prefs() {
        for mode in ThemeMode::ALL {
            assert_eq!(ThemeMode::parse(mode.id()), Some(mode));
            let ui = UiState { theme: mode, ..UiState::default() };
            let back: UiState = serde_json::from_value(serde_json::to_value(&ui).unwrap_or_default()).unwrap_or_default();
            assert_eq!(back.theme, mode);
        }
        assert_eq!(ThemeMode::parse(" Light "), Some(ThemeMode::Light));
        assert_eq!(ThemeMode::parse("sepia"), None);
    }

    #[test]
    fn theme_command_sets_and_reports_the_mode() {
        let mut app = SoundApp::new(soundcraft_engine::Engine::default(), None, Services::default());
        assert_eq!(app.run("ui.theme", json!({})), Ok(json!({"mode": "dark"})));
        assert_eq!(app.run("ui.theme", json!({"mode": "light"})), Ok(json!({"mode": "light"})));
        assert_eq!(app.ui.theme, ThemeMode::Light);
        assert!(app.run("ui.theme", json!({"mode": "sepia"})).is_err());
        assert_eq!(app.ui.theme, ThemeMode::Light);
        assert_eq!(app.run("ui.theme", json!({"mode": "system"})), Ok(json!({"mode": "system"})));
        assert!(crate::menus::UI_COMMANDS.iter().any(|c| c.0 == "ui.theme"));
    }

    #[test]
    fn application_frames_follow_system_appearance_and_preserve_manual_palettes() {
        // Mixer rendering tests also change the process-wide custom-painted palette.
        let _palette = lock_test_palette();
        fn frame(app: &mut SoundApp, ctx: &egui::Context, system_theme: Option<egui::Theme>, light: bool) {
            let mode = app.ui.theme;
            let colors = |app: &SoundApp| {
                app.engine
                    .session()
                    .tracks
                    .iter()
                    .map(|track| {
                        (track.color, track.playlists.iter().flat_map(|playlist| &playlist.clips).map(|clip| clip.color).collect::<Vec<_>>())
                    })
                    .collect::<Vec<_>>()
            };
            let before = colors(app);
            let mut output = ctx.run_ui(egui::RawInput { system_theme, ..Default::default() }, |ui| {
                let ctx = ui.ctx().clone();
                app.logic(&ctx);
                let tokens = if light { Tokens::LIGHT } else { Tokens::DARK };
                assert_eq!(is_light(), light, "custom palette for {mode:?} with {system_theme:?}");
                assert_eq!(Tokens::current().panel_bg, tokens.panel_bg);
                assert_eq!(ctx.options(|options| options.theme_preference), egui::ThemePreference::System);
                for theme in [egui::Theme::Light, egui::Theme::Dark] {
                    let style = ctx.style_of(theme);
                    assert_eq!(style.visuals.dark_mode, !light);
                    assert_eq!(style.visuals.panel_fill, tokens.panel_bg);
                    assert_eq!(style.visuals.widgets.inactive.bg_fill, tokens.button);
                    assert_eq!(style.visuals.widgets.inactive.fg_stroke.color, tokens.text);
                    assert_eq!(style.spacing.button_padding, egui::vec2(6.0, 2.0));
                }
                app.ui(ui);
                assert_eq!(ui.visuals().panel_fill, tokens.panel_bg);
                assert_eq!(ui.visuals().widgets.inactive.bg_fill, tokens.button);
            });
            output.textures_delta.clear();
            assert_eq!(app.ui.theme, mode);
            assert_eq!(serde_json::to_value(&app.ui).unwrap()["theme"], mode.id());
            assert_eq!(colors(app), before, "appearance must preserve track and clip colors");
        }

        let appearances = [Some(egui::Theme::Light), Some(egui::Theme::Dark), Some(egui::Theme::Light), None];
        for initial in [Some(egui::Theme::Light), Some(egui::Theme::Dark), None] {
            let ctx = egui::Context::default();
            let mut app = SoundApp::new(soundcraft_engine::Engine::default(), None, Services::default());
            app.ui = serde_json::from_value(json!({"theme": "system"})).unwrap();
            frame(&mut app, &ctx, initial, initial == Some(egui::Theme::Light));
        }

        let ctx = egui::Context::default();
        let mut engine = soundcraft_engine::demo::demo_engine();
        let track = engine.session_mut().tracks.first_mut().unwrap();
        track.color = [19, 83, 147];
        track.playlists.iter_mut().flat_map(|playlist| &mut playlist.clips).next().unwrap().color = Some([211, 57, 99]);
        let mut app = SoundApp::new(engine, None, Services::default());
        for mode in [ThemeMode::System, ThemeMode::Light, ThemeMode::Dark] {
            app.run("ui.theme", json!({"mode": mode.id()})).unwrap();
            for appearance in appearances {
                let light = mode == ThemeMode::Light || (mode == ThemeMode::System && appearance == Some(egui::Theme::Light));
                frame(&mut app, &ctx, appearance, light);
            }
            if mode != ThemeMode::System {
                let latest = if mode == ThemeMode::Light { egui::Theme::Dark } else { egui::Theme::Light };
                frame(&mut app, &ctx, Some(latest), mode == ThemeMode::Light);
                app.run("ui.theme", json!({"mode": "system"})).unwrap();
                // Resolve the current context immediately, without another OS appearance event.
                app.logic(&ctx);
                assert_eq!(is_light(), latest == egui::Theme::Light);
                assert_eq!(ctx.global_style().visuals.dark_mode, latest != egui::Theme::Light);
                frame(&mut app, &ctx, Some(latest), latest == egui::Theme::Light);
            }
        }
    }
}
