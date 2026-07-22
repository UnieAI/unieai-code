//! Terminal color-support detection and RGB quantization.
//!
//! Self-contained module (depends only on `ratatui::style::Color` and `std`).
//! It answers two questions the theme layer needs before it emits SGR color
//! sequences:
//!
//! 1. *How much color can this terminal actually render?*
//!    [`ColorLevel`] — `None` / `Basic` (16) / `Ansi256` / `TrueColor` — is
//!    derived from the environment ([`detect_level`]) with an explicit
//!    `*_FORCE_COLOR_LEVEL` override so users on lying/exotic terminals can
//!    pin the level.
//! 2. *Given a level, what is the best representation of an arbitrary RGB?*
//!    [`quantize`] downgrades any [`Color`] to the highest fidelity the level
//!    supports: TrueColor passes through, `Ansi256` snaps RGB to the 6×6×6
//!    color cube or the 24-step grayscale ramp (whichever is nearer), `Basic`
//!    snaps to the nearest of the 16 named ANSI colors, and `None` resets.
//!
//! This mirrors the `color_support` approach used by other Rust TUIs and is
//! deliberately env-driven (no TTY round-trip) so it works over SSH/tmux and
//! is trivially unit-testable.

use ratatui::style::Color;

/// Terminal color-support level, ordered low → high.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColorLevel {
    /// No color support (monochrome / `NO_COLOR`).
    None,
    /// Basic 16-color ANSI (SGR 30–37 / 90–97).
    Basic,
    /// 256-color indexed palette (SGR 38;5;N).
    Ansi256,
    /// 24-bit truecolor RGB (SGR 38;2;R;G;B).
    TrueColor,
}

impl ColorLevel {
    pub fn has_color(self) -> bool {
        self >= Self::Basic
    }

    pub fn has_256(self) -> bool {
        self >= Self::Ansi256
    }

    pub fn has_truecolor(self) -> bool {
        self >= Self::TrueColor
    }

    /// Canonical lowercase spelling that round-trips through [`ColorLevel::parse`].
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Basic => "basic",
            Self::Ansi256 => "256",
            Self::TrueColor => "truecolor",
        }
    }

    /// Parse a user-provided level string (case/spelling tolerant). Accepts the
    /// canonical names plus common aliases (`16`, `ansi256`, `24bit`, `off`…).
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" | "off" | "0" | "no" | "mono" | "monochrome" => Some(Self::None),
            "basic" | "16" | "ansi" | "ansi16" | "1" => Some(Self::Basic),
            "256" | "ansi256" | "8bit" | "2" => Some(Self::Ansi256),
            "truecolor" | "true" | "24bit" | "16m" | "rgb" | "3" => Some(Self::TrueColor),
            _ => None,
        }
    }
}

impl std::fmt::Display for ColorLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ── Level detection ──────────────────────────────────────────────────────

/// Environment variables (in priority order) that force a specific color
/// level, overriding everything else — including `NO_COLOR`.
const FORCE_LEVEL_VARS: [&str; 2] = ["UNIEAI_FORCE_COLOR_LEVEL", "CODEX_FORCE_COLOR_LEVEL"];

/// Detect the terminal color level from the process environment.
///
/// Reads (in order): `UNIEAI_FORCE_COLOR_LEVEL` / `CODEX_FORCE_COLOR_LEVEL`
/// (override), `NO_COLOR`, `COLORTERM`, `TERM`. See [`level_from_env`] for the
/// pure decision logic.
pub fn detect_level() -> ColorLevel {
    let force = FORCE_LEVEL_VARS
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .filter(|v| !v.is_empty());
    level_from_env(
        std::env::var_os("NO_COLOR").is_some(),
        force.as_deref(),
        std::env::var("COLORTERM").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
    )
}

/// Pure color-level decision, separated from `std::env` for testing.
///
/// Precedence:
/// 1. `force` — an explicit `*_FORCE_COLOR_LEVEL` value wins over all else
///    (so a user can pin truecolor even on a `dumb` `TERM`, or force `none`).
/// 2. `no_color` — honor the `NO_COLOR` convention → [`ColorLevel::None`].
/// 3. `COLORTERM` = `truecolor` / `24bit` → [`ColorLevel::TrueColor`].
/// 4. `TERM` containing `256color` → [`ColorLevel::Ansi256`].
/// 5. `TERM` = `dumb` or unset/empty → [`ColorLevel::None`].
/// 6. Any other non-empty `TERM` → [`ColorLevel::Basic`].
pub fn level_from_env(
    no_color: bool,
    force: Option<&str>,
    colorterm: Option<&str>,
    term: Option<&str>,
) -> ColorLevel {
    if let Some(forced) = force.and_then(ColorLevel::parse) {
        return forced;
    }
    if no_color {
        return ColorLevel::None;
    }

    if let Some(ct) = colorterm {
        let ct = ct.to_ascii_lowercase();
        if ct.contains("truecolor") || ct.contains("24bit") {
            return ColorLevel::TrueColor;
        }
    }

    match term {
        Some(t) if t.contains("256color") => ColorLevel::Ansi256,
        Some(t) if t.is_empty() || t == "dumb" => ColorLevel::None,
        Some(_) => ColorLevel::Basic,
        None => ColorLevel::None,
    }
}

/// Explicit `*_FORCE_COLOR_LEVEL` override, if set to a parseable level.
///
/// Exposed separately from [`detect_level`] so pre-existing detection paths
/// (e.g. [`crate::terminal_palette::stdout_color_level`], which drives diff
/// backgrounds and table separators) can honor the same override without
/// replacing their own capability probing.
pub fn forced_level() -> Option<ColorLevel> {
    FORCE_LEVEL_VARS
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .filter(|v| !v.is_empty())
        .and_then(|v| ColorLevel::parse(&v))
}

// ── Process-wide active level ────────────────────────────────────────────

static ACTIVE_LEVEL: std::sync::OnceLock<ColorLevel> = std::sync::OnceLock::new();

/// Detect and pin the process-wide color level. Called once at TUI startup
/// (after the environment is final); later calls return the pinned level.
pub fn init_active_level() -> ColorLevel {
    *ACTIVE_LEVEL.get_or_init(detect_level)
}

/// The pinned process-wide level.
///
/// Defaults to [`ColorLevel::TrueColor`] (identity adaptation) when
/// [`init_active_level`] has not run — notably in unit tests, which opt in to
/// quantization explicitly through the `*_for_level` helpers instead of
/// mutating process globals.
pub fn active_level() -> ColorLevel {
    ACTIVE_LEVEL.get().copied().unwrap_or(ColorLevel::TrueColor)
}

/// Adapt a color to the terminal this process is actually talking to: on
/// truecolor terminals this is the identity; on lesser terminals RGB (and,
/// under `basic`, indexed) colors are quantized via [`quantize`] instead of
/// leaving the approximation to the terminal.
pub fn adapt_color(color: Color) -> Color {
    adapt_color_for_level(color, active_level())
}

/// Pure core of [`adapt_color`], parameterized by level for tests and for
/// callers that already resolved a level.
pub fn adapt_color_for_level(color: Color, level: ColorLevel) -> Color {
    quantize(color, level)
}

// ── Quantization ─────────────────────────────────────────────────────────

/// Downgrade a [`Color`] to the best representation `level` supports.
///
/// | level      | `Rgb`                       | `Indexed`                | Named        |
/// |------------|-----------------------------|--------------------------|--------------|
/// | TrueColor  | pass-through                | pass-through             | pass-through |
/// | Ansi256    | → nearest cube/gray `Indexed` | pass-through           | pass-through |
/// | Basic      | → nearest ANSI-16 named      | → nearest ANSI-16 named | pass-through |
/// | None       | → `Reset`                    | → `Reset`               | → `Reset`    |
pub fn quantize(color: Color, level: ColorLevel) -> Color {
    match level {
        ColorLevel::TrueColor => color,
        ColorLevel::Ansi256 => match color {
            Color::Rgb(r, g, b) => Color::Indexed(rgb_to_ansi256(r, g, b)),
            other => other,
        },
        ColorLevel::Basic => match color {
            Color::Rgb(r, g, b) => rgb_to_ansi16(r, g, b),
            Color::Indexed(n) => {
                let (r, g, b) = indexed_to_rgb(n);
                rgb_to_ansi16(r, g, b)
            }
            other => other,
        },
        ColorLevel::None => Color::Reset,
    }
}

// ── RGB → 256 (6×6×6 cube + 24-step grayscale) ───────────────────────────

/// xterm 6×6×6 color-cube channel steps.
const CUBE_STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];

fn sq_dist(a: (u8, u8, u8), b: (u8, u8, u8)) -> u32 {
    let dr = a.0 as i32 - b.0 as i32;
    let dg = a.1 as i32 - b.1 as i32;
    let db = a.2 as i32 - b.2 as i32;
    (dr * dr + dg * dg + db * db) as u32
}

/// Nearest cube-step index (0–5) for a single channel value.
fn nearest_cube_step(v: u8) -> usize {
    let mut best = 0usize;
    let mut best_d = u32::MAX;
    for (i, &s) in CUBE_STEPS.iter().enumerate() {
        let d = (v as i32 - s as i32).unsigned_abs();
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

/// Map an RGB triplet to the nearest xterm-256 index, choosing between the
/// 6×6×6 color cube (indices 16–231) and the 24-step grayscale ramp
/// (indices 232–255) by squared-Euclidean distance.
pub fn rgb_to_ansi256(r: u8, g: u8, b: u8) -> u8 {
    // Color-cube candidate.
    let ri = nearest_cube_step(r);
    let gi = nearest_cube_step(g);
    let bi = nearest_cube_step(b);
    let cube_index = 16 + 36 * ri + 6 * gi + bi;
    let cube_rgb = (CUBE_STEPS[ri], CUBE_STEPS[gi], CUBE_STEPS[bi]);
    let cube_dist = sq_dist((r, g, b), cube_rgb);

    // Grayscale-ramp candidate: values 8, 18, … 238 at indices 232–255.
    let avg = ((r as u32 + g as u32 + b as u32) / 3) as i32;
    let gray_n = ((avg - 8 + 5) / 10).clamp(0, 23) as usize;
    let gray_v = (8 + 10 * gray_n) as u8;
    let gray_index = 232 + gray_n;
    let gray_dist = sq_dist((r, g, b), (gray_v, gray_v, gray_v));

    if gray_dist < cube_dist {
        gray_index as u8
    } else {
        cube_index as u8
    }
}

// ── 256 → RGB ────────────────────────────────────────────────────────────

/// Standard ANSI-16 palette RGB values (xterm defaults).
const ANSI16_RGB: [(u8, u8, u8); 16] = [
    (0, 0, 0),       // 0 black
    (128, 0, 0),     // 1 red
    (0, 128, 0),     // 2 green
    (128, 128, 0),   // 3 yellow
    (0, 0, 128),     // 4 blue
    (128, 0, 128),   // 5 magenta
    (0, 128, 128),   // 6 cyan
    (192, 192, 192), // 7 white (silver)
    (128, 128, 128), // 8 bright black (dark gray)
    (255, 0, 0),     // 9 bright red
    (0, 255, 0),     // 10 bright green
    (255, 255, 0),   // 11 bright yellow
    (0, 0, 255),     // 12 bright blue
    (255, 0, 255),   // 13 bright magenta
    (0, 255, 255),   // 14 bright cyan
    (255, 255, 255), // 15 bright white
];

/// Convert a 256-color index to its approximate RGB value.
pub fn indexed_to_rgb(n: u8) -> (u8, u8, u8) {
    match n {
        0..=15 => ANSI16_RGB[n as usize],
        16..=231 => {
            let i = n as usize - 16;
            (
                CUBE_STEPS[i / 36],
                CUBE_STEPS[(i / 6) % 6],
                CUBE_STEPS[i % 6],
            )
        }
        232..=255 => {
            let v = 8 + 10 * (n as u16 - 232);
            (v as u8, v as u8, v as u8)
        }
    }
}

// ── RGB → ANSI-16 named color ────────────────────────────────────────────

/// Map an RGB triplet to the nearest of the 16 named ANSI colors.
pub fn rgb_to_ansi16(r: u8, g: u8, b: u8) -> Color {
    const NAMED: [Color; 16] = [
        Color::Black,
        Color::Red,
        Color::Green,
        Color::Yellow,
        Color::Blue,
        Color::Magenta,
        Color::Cyan,
        Color::Gray,
        Color::DarkGray,
        Color::LightRed,
        Color::LightGreen,
        Color::LightYellow,
        Color::LightBlue,
        Color::LightMagenta,
        Color::LightCyan,
        Color::White,
    ];
    let mut best = Color::White;
    let mut best_d = u32::MAX;
    for (i, &palette_rgb) in ANSI16_RGB.iter().enumerate() {
        let d = sq_dist((r, g, b), palette_rgb);
        if d < best_d {
            best_d = d;
            best = NAMED[i];
        }
    }
    best
}

// ── OSC 11 background parsing (pure; no TTY round-trip) ───────────────────

/// Terminal background lightness, for auto dark/light theme selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
}

/// Luminance threshold: backgrounds with relative luminance < 0.5 are dark.
const LUMINANCE_THRESHOLD: f64 = 0.5;

/// Parse the RGB components from an OSC 11 response string, e.g.
/// `\x1b]11;rgb:1a1a/1b1b/2626\x07`. Handles both 4-digit
/// (`rgb:RRRR/GGGG/BBBB`) and 2-digit (`rgb:RR/GG/BB`) hex; for wide values the
/// high byte is used. Returns `None` if the response is malformed.
pub fn parse_osc11_rgb(response: &str) -> Option<(u8, u8, u8)> {
    let rgb_start = response.find("rgb:")? + 4;
    let rgb_part = &response[rgb_start..];
    let parts: Vec<&str> = rgb_part.split(['/', '\x07', '\x1b']).take(3).collect();
    if parts.len() < 3 {
        return None;
    }
    Some((
        parse_channel(parts[0])?,
        parse_channel(parts[1])?,
        parse_channel(parts[2])?,
    ))
}

fn parse_channel(s: &str) -> Option<u8> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let val = u16::from_str_radix(trimmed, 16).ok()?;
    Some(if trimmed.len() > 2 {
        (val >> 8) as u8
    } else {
        val as u8
    })
}

/// Classify an sRGB color as [`Appearance::Dark`] or [`Appearance::Light`] via
/// ITU-R BT.709 relative luminance (with sRGB gamma).
pub fn classify_luminance(r: u8, g: u8, b: u8) -> Appearance {
    let luminance =
        0.2126 * srgb_to_linear(r) + 0.7152 * srgb_to_linear(g) + 0.0722 * srgb_to_linear(b);
    if luminance < LUMINANCE_THRESHOLD {
        Appearance::Dark
    } else {
        Appearance::Light
    }
}

fn srgb_to_linear(c: u8) -> f64 {
    let s = c as f64 / 255.0;
    if s <= 0.04045 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ColorLevel basics ────────────────────────────────────────────────

    #[test]
    fn level_ordering_and_capabilities() {
        assert!(ColorLevel::None < ColorLevel::Basic);
        assert!(ColorLevel::Basic < ColorLevel::Ansi256);
        assert!(ColorLevel::Ansi256 < ColorLevel::TrueColor);

        assert!(!ColorLevel::None.has_color());
        assert!(ColorLevel::Basic.has_color());
        assert!(!ColorLevel::Basic.has_256());
        assert!(ColorLevel::Ansi256.has_256());
        assert!(!ColorLevel::Ansi256.has_truecolor());
        assert!(ColorLevel::TrueColor.has_truecolor());
    }

    #[test]
    fn as_str_round_trips_through_parse() {
        for level in [
            ColorLevel::None,
            ColorLevel::Basic,
            ColorLevel::Ansi256,
            ColorLevel::TrueColor,
        ] {
            assert_eq!(ColorLevel::parse(level.as_str()), Some(level));
        }
        // Alias tolerance.
        assert_eq!(ColorLevel::parse("16"), Some(ColorLevel::Basic));
        assert_eq!(ColorLevel::parse("24bit"), Some(ColorLevel::TrueColor));
        assert_eq!(ColorLevel::parse("  TrueColor "), Some(ColorLevel::TrueColor));
        assert_eq!(ColorLevel::parse("off"), Some(ColorLevel::None));
        assert_eq!(ColorLevel::parse("nonsense"), None);
    }

    // ── level_from_env ───────────────────────────────────────────────────

    #[test]
    fn env_force_override_wins_over_everything() {
        // Force truecolor even on a dumb terminal with NO_COLOR set.
        assert_eq!(
            level_from_env(true, Some("truecolor"), None, Some("dumb")),
            ColorLevel::TrueColor
        );
        // Force none even when COLORTERM claims truecolor.
        assert_eq!(
            level_from_env(false, Some("none"), Some("truecolor"), Some("xterm-256color")),
            ColorLevel::None
        );
    }

    #[test]
    fn env_no_color_forces_none() {
        assert_eq!(
            level_from_env(true, None, Some("truecolor"), Some("xterm-256color")),
            ColorLevel::None
        );
    }

    #[test]
    fn env_colorterm_truecolor() {
        assert_eq!(
            level_from_env(false, None, Some("truecolor"), Some("xterm")),
            ColorLevel::TrueColor
        );
        assert_eq!(
            level_from_env(false, None, Some("24bit"), Some("xterm")),
            ColorLevel::TrueColor
        );
    }

    #[test]
    fn env_term_256color() {
        assert_eq!(
            level_from_env(false, None, None, Some("xterm-256color")),
            ColorLevel::Ansi256
        );
        assert_eq!(
            level_from_env(false, None, None, Some("screen-256color")),
            ColorLevel::Ansi256
        );
    }

    #[test]
    fn env_basic_and_dumb_and_missing() {
        assert_eq!(
            level_from_env(false, None, None, Some("xterm")),
            ColorLevel::Basic
        );
        assert_eq!(
            level_from_env(false, None, None, Some("dumb")),
            ColorLevel::None
        );
        assert_eq!(level_from_env(false, None, None, Some("")), ColorLevel::None);
        assert_eq!(level_from_env(false, None, None, None), ColorLevel::None);
    }

    #[test]
    fn env_invalid_force_is_ignored() {
        // A garbage override falls through to normal detection.
        assert_eq!(
            level_from_env(false, Some("purple"), None, Some("xterm-256color")),
            ColorLevel::Ansi256
        );
    }

    // ── quantize ─────────────────────────────────────────────────────────

    #[test]
    fn truecolor_passes_through() {
        let rgb = Color::Rgb(122, 162, 247);
        assert_eq!(quantize(rgb, ColorLevel::TrueColor), rgb);
        let idx = Color::Indexed(141);
        assert_eq!(quantize(idx, ColorLevel::TrueColor), idx);
    }

    #[test]
    fn ansi256_quantizes_rgb_to_indexed_and_passes_indexed_through() {
        let q = quantize(Color::Rgb(122, 162, 247), ColorLevel::Ansi256);
        assert!(matches!(q, Color::Indexed(_)));
        assert_eq!(
            quantize(Color::Indexed(141), ColorLevel::Ansi256),
            Color::Indexed(141)
        );
    }

    #[test]
    fn none_resets_everything() {
        assert_eq!(
            quantize(Color::Rgb(100, 200, 50), ColorLevel::None),
            Color::Reset
        );
        assert_eq!(quantize(Color::Indexed(111), ColorLevel::None), Color::Reset);
        assert_eq!(quantize(Color::Red, ColorLevel::None), Color::Reset);
    }

    #[test]
    fn named_colors_pass_through_color_levels() {
        for level in [ColorLevel::TrueColor, ColorLevel::Ansi256, ColorLevel::Basic] {
            assert_eq!(quantize(Color::Red, level), Color::Red);
            assert_eq!(quantize(Color::Blue, level), Color::Blue);
        }
    }

    #[test]
    fn basic_quantizes_rgb_to_named() {
        assert_eq!(quantize(Color::Rgb(255, 0, 0), ColorLevel::Basic), Color::LightRed);
        assert_eq!(quantize(Color::Rgb(0, 0, 0), ColorLevel::Basic), Color::Black);
        assert_eq!(
            quantize(Color::Rgb(255, 255, 255), ColorLevel::Basic),
            Color::White
        );
    }

    #[test]
    fn basic_quantizes_indexed_to_named() {
        // Indexed(196) = pure bright red in the cube → LightRed.
        assert_eq!(quantize(Color::Indexed(196), ColorLevel::Basic), Color::LightRed);
        // Indexed(0) is black.
        assert_eq!(quantize(Color::Indexed(0), ColorLevel::Basic), Color::Black);
    }

    // ── adapt_color ──────────────────────────────────────────────────────

    #[test]
    fn adapt_color_identity_under_truecolor() {
        let rgb = Color::Rgb(122, 162, 247);
        assert_eq!(adapt_color_for_level(rgb, ColorLevel::TrueColor), rgb);
        assert_eq!(
            adapt_color_for_level(Color::Indexed(141), ColorLevel::TrueColor),
            Color::Indexed(141)
        );
    }

    #[test]
    fn adapt_color_rgb_to_indexed_under_ansi256() {
        assert!(matches!(
            adapt_color_for_level(Color::Rgb(122, 162, 247), ColorLevel::Ansi256),
            Color::Indexed(_)
        ));
    }

    #[test]
    fn adapt_color_rgb_to_named_under_basic() {
        assert_eq!(
            adapt_color_for_level(Color::Rgb(255, 0, 0), ColorLevel::Basic),
            Color::LightRed
        );
        // Indexed also collapses to named under basic.
        assert_eq!(
            adapt_color_for_level(Color::Indexed(196), ColorLevel::Basic),
            Color::LightRed
        );
    }

    #[test]
    fn adapt_color_non_rgb_passthrough() {
        for level in [ColorLevel::TrueColor, ColorLevel::Ansi256, ColorLevel::Basic] {
            assert_eq!(adapt_color_for_level(Color::Red, level), Color::Red);
            assert_eq!(adapt_color_for_level(Color::Reset, level), Color::Reset);
        }
        // Indexed passes through at 256-color level.
        assert_eq!(
            adapt_color_for_level(Color::Indexed(200), ColorLevel::Ansi256),
            Color::Indexed(200)
        );
    }

    #[test]
    fn adapt_color_resets_under_none() {
        assert_eq!(
            adapt_color_for_level(Color::Rgb(1, 2, 3), ColorLevel::None),
            Color::Reset
        );
        assert_eq!(
            adapt_color_for_level(Color::Red, ColorLevel::None),
            Color::Reset
        );
    }

    #[test]
    fn active_level_defaults_to_truecolor_without_init() {
        // Unit tests never call init_active_level, so adapt_color must be the
        // identity here — this is what keeps every pre-existing rendering test
        // (which asserts raw Rgb spans) byte-for-byte unchanged.
        assert_eq!(active_level(), ColorLevel::TrueColor);
        let rgb = Color::Rgb(9, 9, 9);
        assert_eq!(adapt_color(rgb), rgb);
    }

    // ── rgb_to_ansi256 math ──────────────────────────────────────────────

    #[test]
    fn ansi256_pure_colors_hit_cube_corners() {
        // Cube layout: index = 16 + 36*r + 6*g + b, steps [0,95,135,175,215,255]
        assert_eq!(rgb_to_ansi256(0, 0, 0), 16); // black corner
        assert_eq!(rgb_to_ansi256(255, 255, 255), 231); // white corner
        assert_eq!(rgb_to_ansi256(255, 0, 0), 196); // red corner (16 + 36*5)
        assert_eq!(rgb_to_ansi256(0, 255, 0), 46); // green corner (16 + 6*5)
        assert_eq!(rgb_to_ansi256(0, 0, 255), 21); // blue corner (16 + 5)
    }

    #[test]
    fn ansi256_gray_prefers_grayscale_ramp() {
        // A neutral gray closer to a ramp step than any cube step.
        let idx = rgb_to_ansi256(0x77, 0x77, 0x77);
        assert!(
            (232..=255).contains(&idx),
            "expected grayscale ramp index, got {idx}"
        );
    }

    #[test]
    fn ansi256_indices_are_in_range() {
        for r in [0u8, 40, 90, 128, 200, 255] {
            for g in [0u8, 40, 90, 128, 200, 255] {
                for b in [0u8, 40, 90, 128, 200, 255] {
                    let idx = rgb_to_ansi256(r, g, b);
                    assert!(idx >= 16, "index {idx} must be >= 16");
                }
            }
        }
    }

    // ── indexed_to_rgb round-trip ────────────────────────────────────────

    #[test]
    fn indexed_to_rgb_known_values() {
        assert_eq!(indexed_to_rgb(0), (0, 0, 0));
        assert_eq!(indexed_to_rgb(15), (255, 255, 255));
        assert_eq!(indexed_to_rgb(16), (0, 0, 0)); // cube origin
        assert_eq!(indexed_to_rgb(196), (255, 0, 0)); // cube red
        assert_eq!(indexed_to_rgb(231), (255, 255, 255)); // cube white
        assert_eq!(indexed_to_rgb(232), (8, 8, 8)); // first gray
        assert_eq!(indexed_to_rgb(255), (238, 238, 238)); // last gray
    }

    // ── rgb_to_ansi16 ────────────────────────────────────────────────────

    #[test]
    fn rgb_to_ansi16_primaries() {
        assert_eq!(rgb_to_ansi16(255, 0, 0), Color::LightRed);
        assert_eq!(rgb_to_ansi16(0, 255, 0), Color::LightGreen);
        assert_eq!(rgb_to_ansi16(0, 0, 255), Color::LightBlue);
        assert_eq!(rgb_to_ansi16(0, 0, 0), Color::Black);
        assert_eq!(rgb_to_ansi16(128, 0, 0), Color::Red);
    }

    // ── OSC 11 parse + classify ──────────────────────────────────────────

    #[test]
    fn parse_osc11_4digit_and_2digit() {
        assert_eq!(
            parse_osc11_rgb("\x1b]11;rgb:ffff/ffff/ffff\x07"),
            Some((255, 255, 255))
        );
        assert_eq!(
            parse_osc11_rgb("\x1b]11;rgb:1a/1b/26\x07"),
            Some((0x1a, 0x1b, 0x26))
        );
        // ST terminator instead of BEL.
        assert_eq!(
            parse_osc11_rgb("\x1b]11;rgb:8080/8080/8080\x1b\\"),
            Some((128, 128, 128))
        );
    }

    #[test]
    fn parse_osc11_rejects_malformed() {
        assert!(parse_osc11_rgb("").is_none());
        assert!(parse_osc11_rgb("\x1b]11;color:ffff/ffff/ffff\x07").is_none());
        assert!(parse_osc11_rgb("\x1b]11;rgb:ffff/ffff\x07").is_none());
        assert!(parse_osc11_rgb("\x1b]11;rgb:gg/hh/ii\x07").is_none());
    }

    #[test]
    fn classify_luminance_dark_and_light() {
        assert_eq!(classify_luminance(0, 0, 0), Appearance::Dark);
        assert_eq!(classify_luminance(255, 255, 255), Appearance::Light);
        // TokyoNight bg #1a1b26 → dark; #f0f0f0 → light.
        assert_eq!(classify_luminance(0x1a, 0x1b, 0x26), Appearance::Dark);
        assert_eq!(classify_luminance(0xf0, 0xf0, 0xf0), Appearance::Light);
        // Boundary around mid-gray.
        assert_eq!(classify_luminance(186, 186, 186), Appearance::Dark);
        assert_eq!(classify_luminance(188, 188, 188), Appearance::Light);
    }
}
