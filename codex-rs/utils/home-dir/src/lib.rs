use codex_utils_absolute_path::AbsolutePathBuf;
use dirs::home_dir;
use std::path::PathBuf;

/// Returns the path to the UnieAI Code configuration directory. It can be
/// overridden with the `UNIEAI_HOME` environment variable (or `CODEX_HOME`,
/// kept for compatibility with upstream tooling and tests). If neither is
/// set, defaults to `~/.unieai`.
///
/// - If an override is set, the value must exist and be a directory. The
///   value will be canonicalized and this function will Err otherwise.
/// - Without an override, this function does not verify that the directory
///   exists.
pub fn find_codex_home() -> std::io::Result<AbsolutePathBuf> {
    // Name the variable the user actually set, so the error messages below
    // point at the one they can fix.
    let codex_home_env = std::env::var("UNIEAI_HOME")
        .ok()
        .filter(|val| !val.is_empty())
        .map(|val| ("UNIEAI_HOME", val))
        .or_else(|| {
            std::env::var("CODEX_HOME")
                .ok()
                .filter(|val| !val.is_empty())
                .map(|val| ("CODEX_HOME", val))
        });
    find_codex_home_from_env(
        codex_home_env
            .as_ref()
            .map(|(var, val)| (*var, val.as_str())),
    )
}

fn find_codex_home_from_env(
    codex_home_env: Option<(&str, &str)>,
) -> std::io::Result<AbsolutePathBuf> {
    // Honor the `UNIEAI_HOME` environment variable (or `CODEX_HOME`) when it is
    // set to allow users (and tests) to override the default location.
    match codex_home_env {
        Some((var, val)) => {
            let path = PathBuf::from(val);
            let metadata = std::fs::metadata(&path).map_err(|err| match err.kind() {
                std::io::ErrorKind::NotFound => std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("{var} points to {val:?}, but that path does not exist"),
                ),
                _ => std::io::Error::new(err.kind(), format!("failed to read {var} {val:?}: {err}")),
            })?;

            if !metadata.is_dir() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("{var} points to {val:?}, but that path is not a directory"),
                ))
            } else {
                let canonical = path.canonicalize().map_err(|err| {
                    std::io::Error::new(
                        err.kind(),
                        format!("failed to canonicalize {var} {val:?}: {err}"),
                    )
                })?;
                AbsolutePathBuf::from_absolute_path(canonical)
            }
        }
        None => {
            let mut p = home_dir().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Could not find home directory",
                )
            })?;
            p.push(".unieai");
            AbsolutePathBuf::from_absolute_path(p)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::find_codex_home_from_env;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use dirs::home_dir;
    use pretty_assertions::assert_eq;
    use std::fs;
    use std::io::ErrorKind;
    use tempfile::TempDir;

    #[test]
    fn find_codex_home_env_missing_path_is_fatal() {
        let temp_home = TempDir::new().expect("temp home");
        let missing = temp_home.path().join("missing-codex-home");
        let missing_str = missing
            .to_str()
            .expect("missing codex home path should be valid utf-8");

        let err = find_codex_home_from_env(Some(("UNIEAI_HOME", missing_str)))
            .expect_err("missing UNIEAI_HOME");
        assert_eq!(err.kind(), ErrorKind::NotFound);
        assert!(
            err.to_string().contains("UNIEAI_HOME"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn find_codex_home_env_file_path_is_fatal() {
        let temp_home = TempDir::new().expect("temp home");
        let file_path = temp_home.path().join("codex-home.txt");
        fs::write(&file_path, "not a directory").expect("write temp file");
        let file_str = file_path
            .to_str()
            .expect("file codex home path should be valid utf-8");

        let err = find_codex_home_from_env(Some(("UNIEAI_HOME", file_str)))
            .expect_err("file UNIEAI_HOME");
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("not a directory"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn find_codex_home_env_valid_directory_canonicalizes() {
        let temp_home = TempDir::new().expect("temp home");
        let temp_str = temp_home
            .path()
            .to_str()
            .expect("temp codex home path should be valid utf-8");

        let resolved = find_codex_home_from_env(Some(("UNIEAI_HOME", temp_str)))
            .expect("valid UNIEAI_HOME");
        let expected = temp_home
            .path()
            .canonicalize()
            .expect("canonicalize temp home");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn find_codex_home_without_env_uses_default_home_dir() {
        let resolved =
            find_codex_home_from_env(/*codex_home_env*/ None).expect("default UNIEAI_HOME");
        let mut expected = home_dir().expect("home dir");
        expected.push(".unieai");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }
}
