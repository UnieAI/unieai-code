// Copyright (c) 2026 UnieAI. All rights reserved.

//! Names of the project-level config directory.
//!
//! UnieAI Code loads project config (config.toml, skills/, rules/, agents/,
//! hooks) from `<project>/.unieai/`. Projects created for upstream Codex keep
//! working through the legacy `<project>/.codex/` directory, which is used only
//! when `.unieai/` does not exist.

use std::path::Path;
use std::path::PathBuf;

/// Primary project-level config directory name.
pub const PROJECT_CONFIG_DIR_NAME: &str = ".unieai";

/// Legacy project-level config directory name, used only when
/// [`PROJECT_CONFIG_DIR_NAME`] is absent.
pub const LEGACY_PROJECT_CONFIG_DIR_NAME: &str = ".codex";

/// All project-level config directory names, primary first.
pub const PROJECT_CONFIG_DIR_NAMES: &[&str] =
    &[PROJECT_CONFIG_DIR_NAME, LEGACY_PROJECT_CONFIG_DIR_NAME];

/// Selects which project config directory name applies given which candidate
/// directories exist: `.unieai` wins, `.codex` is the legacy fallback, and
/// `None` means neither exists.
pub fn select_project_config_dir_name(
    primary_exists: bool,
    legacy_exists: bool,
) -> Option<&'static str> {
    if primary_exists {
        Some(PROJECT_CONFIG_DIR_NAME)
    } else if legacy_exists {
        Some(LEGACY_PROJECT_CONFIG_DIR_NAME)
    } else {
        None
    }
}

/// Returns the existing project config directory under `root` (preferring
/// `.unieai`, falling back to legacy `.codex`), or `None` when neither exists.
pub fn existing_project_config_dir(root: &Path) -> Option<PathBuf> {
    select_project_config_dir_name(
        root.join(PROJECT_CONFIG_DIR_NAME).is_dir(),
        root.join(LEGACY_PROJECT_CONFIG_DIR_NAME).is_dir(),
    )
    .map(|name| root.join(name))
}

/// Returns the project config directory that should be read from or written to
/// under `root`: the existing directory when there is one, otherwise the
/// primary `.unieai` directory.
pub fn project_config_dir(root: &Path) -> PathBuf {
    existing_project_config_dir(root).unwrap_or_else(|| root.join(PROJECT_CONFIG_DIR_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn selection_prefers_primary_then_legacy() {
        assert_eq!(select_project_config_dir_name(true, true), Some(".unieai"));
        assert_eq!(select_project_config_dir_name(true, false), Some(".unieai"));
        assert_eq!(select_project_config_dir_name(false, true), Some(".codex"));
        assert_eq!(select_project_config_dir_name(false, false), None);
    }

    #[test]
    fn project_config_dir_resolution() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        assert_eq!(existing_project_config_dir(root), None);
        assert_eq!(project_config_dir(root), root.join(".unieai"));

        std::fs::create_dir(root.join(".codex")).expect("create .codex");
        assert_eq!(existing_project_config_dir(root), Some(root.join(".codex")));
        assert_eq!(project_config_dir(root), root.join(".codex"));

        std::fs::create_dir(root.join(".unieai")).expect("create .unieai");
        assert_eq!(project_config_dir(root), root.join(".unieai"));
    }
}
