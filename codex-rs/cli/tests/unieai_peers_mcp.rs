// Copyright (c) 2026 UnieAI. All rights reserved.
//! Two `unieai peers mcp` servers on one machine find each other and hold a
//! conversation: what one sends, the other reads with `wait_for_messages`,
//! and the answer comes back the same way.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use tempfile::TempDir;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::io::Lines;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;

struct McpClient {
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl McpClient {
    async fn start(codex_home: &Path) -> Result<Self> {
        let mut child = tokio::process::Command::new(codex_utils_cargo_bin::cargo_bin("codex")?)
            .args(["peers", "mcp"])
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().context("stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("stdout")?).lines();
        let mut client = Self {
            _child: child,
            stdin,
            stdout,
            next_id: 1,
        };
        let init = client
            .request("initialize", json!({ "protocolVersion": "2025-06-18" }))
            .await?;
        assert_eq!(init["serverInfo"]["name"], json!("unieai-peers"));
        client
            .stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
            .await?;
        Ok(client)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.stdin.write_all(format!("{line}\n").as_bytes()).await?;
        let reply = tokio::time::timeout(Duration::from_secs(60), self.stdout.next_line())
            .await??
            .context("server closed stdout")?;
        let reply: Value = serde_json::from_str(&reply)?;
        assert_eq!(reply["id"], json!(id));
        Ok(reply["result"].clone())
    }

    /// A tool call's text, and whether it was an error.
    async fn call(&mut self, tool: &str, arguments: Value) -> Result<(String, bool)> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await?;
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        Ok((text, result["isError"].as_bool().unwrap_or(true)))
    }

    /// The thread id of the only other member, from `list_peers`.
    async fn only_peer(&mut self) -> Result<String> {
        let (text, is_error) = self.call("list_peers", json!({})).await?;
        assert!(!is_error, "{text}");
        let ids: Vec<&str> = text
            .lines()
            .filter_map(|line| {
                line.rsplit_once("(thread ")
                    .map(|(_, rest)| rest.trim_end_matches(')'))
            })
            .collect();
        assert_eq!(ids.len(), 1, "{text}");
        Ok(ids[0].to_string())
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_mcp_members_hold_a_conversation() -> Result<()> {
    let codex_home = TempDir::new()?;
    let mut claude = McpClient::start(codex_home.path()).await?;
    let mut other = McpClient::start(codex_home.path()).await?;

    let tools = claude.request("tools/list", json!({})).await?;
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .context("tools")?
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            "list_peers",
            "send_message",
            "wait_for_messages",
            "read_messages"
        ]
    );

    let other_id = claude.only_peer().await?;
    let (sent, is_error) = claude
        .call(
            "send_message",
            json!({ "to": other_id, "message": "What is 6 x 7?" }),
        )
        .await?;
    assert!(!is_error, "{sent}");
    assert!(sent.contains("queued"), "{sent}");

    let (received, _) = other
        .call("wait_for_messages", json!({ "timeout_seconds": 20 }))
        .await?;
    assert!(received.contains("What is 6 x 7?"), "{received}");

    let claude_id = other.only_peer().await?;
    let (_, is_error) = other
        .call("send_message", json!({ "to": claude_id, "message": "42" }))
        .await?;
    assert!(!is_error);
    let (answer, _) = claude
        .call(
            "wait_for_messages",
            json!({ "from": other_id, "timeout_seconds": 20 }),
        )
        .await?;
    assert!(answer.contains("42"), "{answer}");

    let (empty, _) = claude.call("read_messages", json!({})).await?;
    assert_eq!(empty, "No messages.");
    Ok(())
}
