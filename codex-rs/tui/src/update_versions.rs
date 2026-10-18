/// Whether `latest` (a released version) is newer than `current` (this binary).
///
/// The two sides are parsed differently on purpose. `latest` comes from a
/// registry or release tag and is expected to be clean semver; a pre-release
/// there fails to parse, which is how pre-releases stay out of update prompts.
/// `current` is `CARGO_PKG_VERSION`, which outside of a stamped release build
/// carries an internal build id (`0.0.19-dev-uc0.5.0-ac0.4.0`), so it is parsed
/// leniently — otherwise every unstamped build compares as "no update".
#[cfg(any(not(debug_assertions), test))]
pub(crate) fn is_newer(latest: &str, current: &str) -> Option<bool> {
    match (parse_version(latest), parse_build_version(current)) {
        (Some(l), Some(c)) => Some(l > c),
        _ => None,
    }
}

#[cfg(any(not(debug_assertions), test))]
pub(crate) fn is_source_build_version(version: &str) -> bool {
    parse_build_version(version) == Some((0, 0, 0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ServerVersionNoticeKind {
    Older,
    Different,
}

/// Stable clients compare release precedence. Prerelease clients only order versions
/// within the same release line; local builds and other release lines compare identity.
pub(crate) fn server_version_notice_kind(
    client: &str,
    server: &str,
) -> Option<ServerVersionNoticeKind> {
    let client = semver::Version::parse(client).ok()?;
    let server = semver::Version::parse(server).ok()?;
    let client_release = (client.major, client.minor, client.patch);
    let server_release = (server.major, server.minor, server.patch);
    let client_is_local = client_release == (0, 0, 0) || !client.build.is_empty();
    if client_is_local || (!client.pre.is_empty() && client_release != server_release) {
        return (client != server).then_some(ServerVersionNoticeKind::Different);
    }
    (server.build.is_empty() && server_release != (0, 0, 0) && client > server)
        .then_some(ServerVersionNoticeKind::Older)
}

#[cfg(any(not(debug_assertions), test))]
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
#[cfg(any(not(debug_assertions), test))]
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

    #[test]
    fn stable_clients_only_warn_for_older_releases() {
        for (client, server, expected) in [
            ("0.152.1", "0.152.0", Some(ServerVersionNoticeKind::Older)),
            ("0.153.0", "0.152.1", Some(ServerVersionNoticeKind::Older)),
            (
                "0.153.0",
                "0.153.0-alpha.10.1",
                Some(ServerVersionNoticeKind::Older),
            ),
            (
                "0.156.0",
                "0.155.0-alpha.12",
                Some(ServerVersionNoticeKind::Older),
            ),
            ("0.153.0", "0.153.0", None),
            ("0.153.0", "0.154.0", None),
            ("0.153.0", "0.154.0-alpha.1", None),
            ("0.153.0", "0.0.0", None),
            ("0.153.0", "0.0.0-alpha.1", None),
            ("0.153.0", "0.152.0+dev", None),
        ] {
            assert_eq!(server_version_notice_kind(client, server), expected);
        }
    }

    #[test]
    fn prerelease_clients_compare_within_the_same_release_line() {
        for (newer, older) in [
            ("0.155.0-alpha.23", "0.155.0-alpha.22"),
            ("0.155.0-alpha.24", "0.155.0-alpha.23"),
            ("0.153.0-alpha.10", "0.153.0-alpha.9"),
            ("0.153.0-alpha.10.1", "0.153.0-alpha.9.2"),
            ("0.153.0-alpha.10.10", "0.153.0-alpha.10.9"),
            ("0.153.0-alpha.10.1", "0.153.0-alpha.10"),
            ("0.155.0", "0.155.0-alpha.23"),
        ] {
            assert_eq!(
                server_version_notice_kind(newer, older),
                Some(ServerVersionNoticeKind::Older)
            );
            assert_eq!(server_version_notice_kind(older, newer), None);
            assert_eq!(server_version_notice_kind(newer, newer), None);
        }
    }

    #[test]
    fn prerelease_clients_on_other_release_lines_and_local_clients_warn_for_mismatches() {
        for (client, server) in [
            ("0.155.0-alpha.23", "0.156.0"),
            ("0.155.0-alpha.12", "0.154.0"),
            ("0.0.0", "0.153.0"),
            ("0.0.0", "0.153.0-alpha.10"),
            ("0.153.0+dev", "0.153.0"),
            ("0.153.0-alpha.10", "0.0.0"),
        ] {
            assert_eq!(
                server_version_notice_kind(client, server),
                Some(ServerVersionNoticeKind::Different)
            );
            assert_eq!(server_version_notice_kind(client, client), None);
        }
    }

    #[test]
    fn unknown_or_malformed_versions_do_not_produce_notices() {
        for version in [
            "unknown",
            "dev",
            "0.0.0.0",
            "0.153",
            "0.153.0.1",
            " 0.153.0",
            "+0.153.0",
            "0.0153.0",
            "0.153.0-alpha.01",
            "0.153.0-alpha..1",
        ] {
            for release in ["0.153.0", "0.153.0-alpha.10", "0.0.0"] {
                assert_eq!(server_version_notice_kind(version, release), None);
                assert_eq!(server_version_notice_kind(release, version), None);
            }
        }
    }
}
