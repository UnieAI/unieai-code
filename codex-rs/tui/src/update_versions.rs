/// Whether `latest` (a released version) is newer than `current` (this binary).
///
/// The two sides are parsed differently on purpose. `latest` comes from a
/// registry or release tag and is expected to be clean semver; a pre-release
/// there fails to parse, which is how pre-releases stay out of update prompts.
/// `current` is `CARGO_PKG_VERSION`, which outside of a stamped release build
/// carries an internal build id (`0.0.19-dev-uc0.5.0-ac0.4.0`), so it is parsed
/// leniently — otherwise every unstamped build compares as "no update".
pub(crate) fn is_newer(latest: &str, current: &str) -> Option<bool> {
    match (parse_version(latest), parse_build_version(current)) {
        (Some(l), Some(c)) => Some(l > c),
        _ => None,
    }
}

pub(crate) fn extract_version_from_latest_tag(latest_tag_name: &str) -> anyhow::Result<String> {
    latest_tag_name
        .strip_prefix("cli-v")
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("Failed to parse latest tag name '{latest_tag_name}'"))
}

pub(crate) fn is_source_build_version(version: &str) -> bool {
    parse_build_version(version) == Some((0, 0, 0))
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut iter = v.trim().split('.');
    let maj = iter.next()?.parse::<u64>().ok()?;
    let min = iter.next()?.parse::<u64>().ok()?;
    let pat = iter.next()?.parse::<u64>().ok()?;
    Some((maj, min, pat))
}

/// Parse this binary's own version, tolerating a trailing build id.
///
/// Release builds are stamped with a clean `MAJOR.MINOR.PATCH` by CI, but an
/// unstamped build reports the in-tree workspace version, which appends an
/// internal id after the patch number. Everything from the first `-` on is
/// dropped so both forms yield the same release triple.
fn parse_build_version(v: &str) -> Option<(u64, u64, u64)> {
    let trimmed = v.trim();
    let release = trimmed.split_once('-').map_or(trimmed, |(head, _)| head);
    parse_version(release)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn extracts_version_from_latest_tag() {
        assert_eq!(
            extract_version_from_latest_tag("cli-v1.5.0").expect("failed to parse version"),
            "1.5.0"
        );
    }

    #[test]
    fn latest_tag_without_prefix_is_invalid() {
        assert!(extract_version_from_latest_tag("v1.5.0").is_err());
    }

    #[test]
    fn prerelease_version_is_not_considered_newer() {
        assert_eq!(is_newer("0.11.0-beta.1", "0.11.0"), None);
        assert_eq!(is_newer("1.0.0-rc.1", "1.0.0"), None);
    }

    #[test]
    fn plain_semver_comparisons_work() {
        assert_eq!(is_newer("0.11.1", "0.11.0"), Some(true));
        assert_eq!(is_newer("0.11.0", "0.11.1"), Some(false));
        assert_eq!(is_newer("1.0.0", "0.9.9"), Some(true));
        assert_eq!(is_newer("0.9.9", "1.0.0"), Some(false));
    }

    #[test]
    fn source_build_version_is_not_checked() {
        assert!(is_source_build_version("0.0.0"));
        assert!(!is_source_build_version("0.1.0"));
        assert!(is_source_build_version("0.0.0-dev"));
        assert!(!is_source_build_version(INTERNAL_BUILD_ID));
    }

    /// The shape `[workspace.package] version` carries between releases.
    const INTERNAL_BUILD_ID: &str = "0.0.19-dev-uc0.5.0-ac0.4.0";

    #[test]
    fn unstamped_build_id_still_compares_against_released_versions() {
        assert_eq!(is_newer("0.0.20", INTERNAL_BUILD_ID), Some(true));
        assert_eq!(is_newer("0.0.19", INTERNAL_BUILD_ID), Some(false));
        assert_eq!(is_newer("0.0.18", INTERNAL_BUILD_ID), Some(false));
    }

    #[test]
    fn a_prerelease_latest_is_still_ignored_against_a_build_id() {
        assert_eq!(is_newer("0.0.20-beta.1", INTERNAL_BUILD_ID), None);
    }

    #[test]
    fn whitespace_is_ignored() {
        assert_eq!(parse_version(" 1.2.3 \n"), Some((1, 2, 3)));
        assert_eq!(is_newer(" 1.2.3 ", "1.2.2"), Some(true));
    }
}
