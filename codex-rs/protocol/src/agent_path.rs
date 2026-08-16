use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::ops::Deref;
use std::str::FromStr;
use ts_rs::TS;

#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String")]
#[ts(type = "string")]
pub struct AgentPath(String);

impl AgentPath {
    pub const ROOT: &str = "/root";
    pub const MORPHEUS: &str = "/morpheus";
    /// Namespace for sessions owned by other processes. Reserved, never
    /// spawnable.
    pub const PEER_ROOT: &str = "/peer";
    const ROOT_SEGMENT: &str = "root";
    const PEER_SEGMENT: &str = "peer";

    pub fn root() -> Self {
        Self(Self::ROOT.to_string())
    }

    /// Path used as the author of a message from another CLI process.
    ///
    /// Peers are given their own namespace rather than reusing `/root`, which
    /// every top-level session already occupies: a receiving model must be able
    /// to tell "someone else's session sent me this" from "my own sub-agent
    /// sent me this", because only one of those carries the user's authority.
    /// Peer paths are never registered as live agents.
    pub fn peer(short_ref: &str) -> Result<Self, String> {
        Self::from_string(format!("{}/{short_ref}", Self::PEER_ROOT))
    }

    /// Whether this path names another process's session rather than an agent
    /// in the local tree.
    pub fn is_peer(&self) -> bool {
        self.as_str()
            .strip_prefix(Self::PEER_ROOT)
            .is_some_and(|rest| rest.starts_with('/'))
    }

    pub fn morpheus() -> Self {
        Self(Self::MORPHEUS.to_string())
    }

    pub fn from_string(path: String) -> Result<Self, String> {
        validate_absolute_path(path.as_str())?;
        Ok(Self(path))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn is_root(&self) -> bool {
        self.as_str() == Self::ROOT
    }

    pub fn name(&self) -> &str {
        if self.is_root() {
            return Self::ROOT_SEGMENT;
        }
        self.as_str()
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(Self::ROOT_SEGMENT)
    }

    pub fn join(&self, agent_name: &str) -> Result<Self, String> {
        validate_agent_name(agent_name)?;
        Self::from_string(format!("{self}/{agent_name}"))
    }

    pub fn resolve(&self, reference: &str) -> Result<Self, String> {
        if reference.is_empty() {
            return Err("agent path must not be empty".to_string());
        }
        if reference == Self::ROOT {
            return Ok(Self::root());
        }
        if reference.starts_with('/') {
            return Self::try_from(reference);
        }

        validate_relative_reference(reference)?;
        Self::from_string(format!("{self}/{reference}"))
    }
}

impl TryFrom<String> for AgentPath {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_string(value)
    }
}

impl TryFrom<&str> for AgentPath {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_string(value.to_string())
    }
}

impl From<AgentPath> for String {
    fn from(value: AgentPath) -> Self {
        value.0
    }
}

impl FromStr for AgentPath {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_from(s)
    }
}

impl AsRef<str> for AgentPath {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Deref for AgentPath {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for AgentPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

fn validate_agent_name(agent_name: &str) -> Result<(), String> {
    if agent_name.is_empty() {
        return Err("agent_name must not be empty".to_string());
    }
    if agent_name == AgentPath::ROOT_SEGMENT {
        return Err("agent_name `root` is reserved".to_string());
    }
    if agent_name == "." || agent_name == ".." {
        return Err(format!("agent_name `{agent_name}` is reserved"));
    }
    if agent_name.contains('/') {
        return Err("agent_name must not contain `/`".to_string());
    }
    if !agent_name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Err(
            "agent_name must use only lowercase letters, digits, and underscores".to_string(),
        );
    }
    Ok(())
}

fn validate_absolute_path(path: &str) -> Result<(), String> {
    if path == AgentPath::MORPHEUS {
        return Ok(());
    }

    let Some(stripped) = path.strip_prefix('/') else {
        return Err("absolute agent paths must start with `/root` or be `/morpheus`".to_string());
    };
    let mut segments = stripped.split('/');
    let Some(root) = segments.next() else {
        return Err("absolute agent path must not be empty".to_string());
    };
    if root != AgentPath::ROOT_SEGMENT && root != AgentPath::PEER_SEGMENT {
        return Err(
            "absolute agent paths must start with `/root` or `/peer`, or be `/morpheus`"
                .to_string(),
        );
    }
    if stripped.ends_with('/') {
        return Err("absolute agent path must not end with `/`".to_string());
    }
    let mut segment_count = 0;
    for segment in segments {
        validate_agent_name(segment)?;
        segment_count += 1;
    }
    // `/peer` alone names no session. Requiring a segment keeps the namespace
    // from ever being confused with a real agent root.
    if root == AgentPath::PEER_SEGMENT && segment_count == 0 {
        return Err("peer agent paths must name a peer, for example `/peer/k2f8`".to_string());
    }
    Ok(())
}

fn validate_relative_reference(reference: &str) -> Result<(), String> {
    if reference.ends_with('/') {
        return Err("relative agent path must not end with `/`".to_string());
    }
    for segment in reference.split('/') {
        validate_agent_name(segment)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AgentPath;
    use pretty_assertions::assert_eq;

    #[test]
    fn root_has_expected_name() {
        let root = AgentPath::root();
        assert_eq!(root.as_str(), AgentPath::ROOT);
        assert_eq!(root.name(), "root");
        assert!(root.is_root());
    }

    #[test]
    fn morpheus_has_expected_name() {
        let morpheus = AgentPath::morpheus();
        assert_eq!(morpheus.as_str(), AgentPath::MORPHEUS);
        assert_eq!(morpheus.name(), "morpheus");
        assert!(!morpheus.is_root());
    }

    #[test]
    fn join_builds_child_paths() {
        let root = AgentPath::root();
        let child = root.join("researcher").expect("child path");
        assert_eq!(child.as_str(), "/root/researcher");
        assert_eq!(child.name(), "researcher");
    }

    #[test]
    fn resolve_supports_relative_and_absolute_references() {
        let current = AgentPath::try_from("/root/researcher").expect("path");
        assert_eq!(
            current.resolve("worker").expect("relative path"),
            AgentPath::try_from("/root/researcher/worker").expect("path")
        );
        assert_eq!(
            current.resolve("/root/other").expect("absolute path"),
            AgentPath::try_from("/root/other").expect("path")
        );
    }

    #[test]
    fn invalid_names_and_paths_are_rejected() {
        assert_eq!(
            AgentPath::root().join("BadName"),
            Err("agent_name must use only lowercase letters, digits, and underscores".to_string())
        );
        assert_eq!(
            AgentPath::try_from("/not-root"),
            Err(
                "absolute agent paths must start with `/root` or `/peer`, or be `/morpheus`"
                    .to_string()
            )
        );
        assert_eq!(
            AgentPath::root().resolve("../sibling"),
            Err("agent_name `..` is reserved".to_string())
        );
    }
}

#[cfg(test)]
mod peer_path_tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn a_peer_path_is_valid_and_identifiable() {
        let peer = AgentPath::peer("k2f8").expect("peer path should be valid");

        assert_eq!(peer.as_str(), "/peer/k2f8");
        assert!(peer.is_peer());
        assert!(!peer.is_root());
        assert_eq!(peer.name(), "k2f8");
    }

    #[test]
    fn root_and_sub_agent_paths_are_not_peers() {
        // A receiving model must be able to tell a peer's message from its own
        // sub-agent's, so these must never be confused.
        assert!(!AgentPath::root().is_peer());
        assert!(
            !AgentPath::root()
                .join("worker")
                .expect("sub-agent path")
                .is_peer()
        );
        assert!(!AgentPath::morpheus().is_peer());
    }

    #[test]
    fn the_peer_namespace_alone_names_nobody() {
        assert!(AgentPath::from_string("/peer".to_string()).is_err());
        assert!(AgentPath::from_string("/peer/".to_string()).is_err());
    }

    #[test]
    fn a_peer_path_round_trips_through_parsing() {
        let parsed = AgentPath::from_string("/peer/k2f8".to_string()).expect("should parse");

        assert_eq!(parsed, AgentPath::peer("k2f8").expect("peer path"));
    }
}
