// Copyright (c) 2026 UnieAI. All rights reserved.
//! The model-facing task queue tools (`publish_task`, `claim_task`,
//! `report_task`, `list_tasks`), engine-neutral.
//!
//! Like [`crate::unieai_tools`] for the peer tools: the codex engine offers
//! these as core function tools, the uac engine as `codex_tui` dynamic tools
//! answered by the TUI. Both run them through [`run_task_tool`], so a model
//! sees the same names, arguments and results whichever engine it runs on.

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

use crate::MeshError;
use crate::MeshNode;
use crate::PeerSelector;

pub const PUBLISH_TASK_TOOL: &str = "publish_task";
pub const CLAIM_TASK_TOOL: &str = "claim_task";
pub const REPORT_TASK_TOOL: &str = "report_task";
pub const LIST_TASKS_TOOL: &str = "list_tasks";

/// Every session publishes to and claims from this queue.
pub const DEFAULT_QUEUE: &str = "default";
/// How many tasks `list_tasks` returns at most.
pub const TASK_LIST_LIMIT: i64 = 50;

pub const PUBLISH_TASK_DESCRIPTION: &str = "Publish work to the machine-local queue for another \
UnieAI Code session to pick up. Returns the task id.";
pub const CLAIM_TASK_DESCRIPTION: &str = "Claim the next task from the machine-local queue. \
Returns the task and a claim token; pass that token to report_task when you finish. Returns \
nothing when the queue is empty. Tasks assigned to this session are offered first.";
pub const REPORT_TASK_DESCRIPTION: &str = "Report the outcome of a task you claimed. If your \
claim expired because this session was considered gone, the report is refused and says so — stop \
working on that task rather than continuing.";
pub const LIST_TASKS_DESCRIPTION: &str = "List tasks on the machine-local queue with their status.";

pub const TITLE_DESCRIPTION: &str = "Short summary of the work.";
pub const BODY_DESCRIPTION: &str =
    "Everything the claiming session needs to do the work without asking you.";
pub const PRIORITY_DESCRIPTION: &str = "Higher is claimed first. Defaults to 0.";
pub const ASSIGN_TO_DESCRIPTION: &str = "Optional peer handle from list_peers. An assigned task \
can only be claimed by that session, and is offered to it ahead of open work.";
pub const TASK_ID_DESCRIPTION: &str = "Task id from claim_task.";
pub const CLAIM_TOKEN_DESCRIPTION: &str = "Claim token from claim_task.";
pub const STATUS_DESCRIPTION: &str = "`done` or `failed`.";
pub const RESULT_DESCRIPTION: &str = "What you produced, for the session that published the task.";
pub const ERROR_DESCRIPTION: &str = "Why it failed, when it failed.";

/// Whether `tool` is one of the task queue tools.
pub fn is_task_tool(tool: &str) -> bool {
    matches!(
        tool,
        PUBLISH_TASK_TOOL | CLAIM_TASK_TOOL | REPORT_TASK_TOOL | LIST_TASKS_TOOL
    )
}

/// `publish_task` arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublishTaskArgs {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub assign_to: Option<String>,
}

/// Arguments of the tools that take none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoArgs {}

/// `report_task` arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportTaskArgs {
    pub task_id: String,
    pub claim_token: String,
    pub status: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `publish_task` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublishTaskResult {
    pub task_id: String,
}

/// `claim_task` result: no task when the queue is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaimTaskResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<ClaimedTask>,
}

/// A claimed task as the model sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaimedTask {
    pub task_id: String,
    pub claim_token: String,
    pub title: String,
    pub body: String,
    pub attempt: i64,
}

/// `report_task` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReportTaskResult {
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// `list_tasks` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListTasksResult {
    pub tasks: Vec<ListedTask>,
}

/// A queued task as `list_tasks` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListedTask {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub attempt_count: i64,
}

/// Publishes a task, resolving `assign_to` first so a typo fails here rather
/// than parking work nobody can claim.
pub async fn publish_task(
    node: &MeshNode,
    args: PublishTaskArgs,
) -> Result<PublishTaskResult, MeshError> {
    let assigned_to = match args.assign_to.as_deref() {
        Some(handle) => Some(node.resolve(&PeerSelector::new(handle)).await?.thread_id),
        None => None,
    };
    let task_id = node
        .sender()
        .publish_task(
            DEFAULT_QUEUE,
            &args.title,
            &args.body,
            args.priority,
            assigned_to,
        )
        .await?;
    Ok(PublishTaskResult { task_id })
}

/// Claims the next task for this session.
pub async fn claim_task(node: &MeshNode) -> Result<ClaimTaskResult, MeshError> {
    let claimed = node.sender().claim_task(DEFAULT_QUEUE).await?;
    Ok(ClaimTaskResult {
        task: claimed.map(|(task, claim_token)| ClaimedTask {
            task_id: task.task_id,
            claim_token,
            title: task.title,
            body: task.body,
            attempt: task.attempt_count,
        }),
    })
}

/// Records a claimed task's outcome; refused when the claim expired.
pub async fn report_task(
    node: &MeshNode,
    args: ReportTaskArgs,
) -> Result<ReportTaskResult, MeshError> {
    let outcome = node
        .sender()
        .report_task(
            &args.task_id,
            &args.claim_token,
            &args.status,
            args.result.as_deref(),
            args.error.as_deref(),
        )
        .await?;
    let recorded = outcome == codex_state::TaskReportOutcome::Recorded;
    Ok(ReportTaskResult {
        recorded,
        note: (!recorded).then(|| {
            "your claim expired and the task was reassigned; stop working on it".to_string()
        }),
    })
}

/// Lists the queue's tasks with their status.
pub async fn list_tasks(node: &MeshNode) -> Result<ListTasksResult, MeshError> {
    let tasks = node
        .sender()
        .list_tasks(DEFAULT_QUEUE, TASK_LIST_LIMIT)
        .await?;
    Ok(ListTasksResult {
        tasks: tasks
            .into_iter()
            .map(|task| ListedTask {
                task_id: task.task_id,
                title: task.title,
                status: task.status,
                attempt_count: task.attempt_count,
            })
            .collect(),
    })
}

/// Runs one task tool from its JSON arguments, answering the JSON the model
/// reads. `Err` carries the message for a failed call.
pub async fn run_task_tool(
    node: &MeshNode,
    tool: &str,
    arguments: Value,
) -> Result<String, String> {
    fn parse<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T, String> {
        // A tool with no parameters may be called with `null`.
        let arguments = if arguments.is_null() {
            json!({})
        } else {
            arguments
        };
        serde_json::from_value(arguments).map_err(|err| format!("invalid arguments: {err}"))
    }
    fn text<T: Serialize>(result: Result<T, MeshError>) -> Result<String, String> {
        let value = result.map_err(|err| err.to_string())?;
        serde_json::to_string(&value).map_err(|err| err.to_string())
    }
    match tool {
        PUBLISH_TASK_TOOL => text(publish_task(node, parse(arguments)?).await),
        CLAIM_TASK_TOOL => {
            let NoArgs {} = parse(arguments)?;
            text(claim_task(node).await)
        }
        REPORT_TASK_TOOL => {
            let args: ReportTaskArgs = parse(arguments)?;
            if args.status != "done" && args.status != "failed" {
                return Err("`status` must be `done` or `failed`".to_string());
            }
            text(report_task(node, args).await)
        }
        LIST_TASKS_TOOL => {
            let NoArgs {} = parse(arguments)?;
            text(list_tasks(node).await)
        }
        other => Err(format!("unknown task tool {other}")),
    }
}

/// JSON Schema of `publish_task`'s arguments.
pub fn publish_task_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": {"type": "string", "description": TITLE_DESCRIPTION},
            "body": {"type": "string", "description": BODY_DESCRIPTION},
            "priority": {"type": "number", "description": PRIORITY_DESCRIPTION},
            "assign_to": {"type": "string", "description": ASSIGN_TO_DESCRIPTION},
        },
        "required": ["title", "body"],
    })
}

/// JSON Schema of `claim_task` and `list_tasks` (no arguments).
pub fn no_arguments_schema() -> Value {
    json!({"type": "object", "additionalProperties": false, "properties": {}})
}

/// JSON Schema of `report_task`'s arguments.
pub fn report_task_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "task_id": {"type": "string", "description": TASK_ID_DESCRIPTION},
            "claim_token": {"type": "string", "description": CLAIM_TOKEN_DESCRIPTION},
            "status": {"type": "string", "description": STATUS_DESCRIPTION},
            "result": {"type": "string", "description": RESULT_DESCRIPTION},
            "error": {"type": "string", "description": ERROR_DESCRIPTION},
        },
        "required": ["task_id", "claim_token", "status"],
    })
}

/// Name, description and argument schema of each task tool.
pub fn task_tool_specs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            PUBLISH_TASK_TOOL,
            PUBLISH_TASK_DESCRIPTION,
            publish_task_input_schema(),
        ),
        (
            CLAIM_TASK_TOOL,
            CLAIM_TASK_DESCRIPTION,
            no_arguments_schema(),
        ),
        (
            REPORT_TASK_TOOL,
            REPORT_TASK_DESCRIPTION,
            report_task_input_schema(),
        ),
        (
            LIST_TASKS_TOOL,
            LIST_TASKS_DESCRIPTION,
            no_arguments_schema(),
        ),
    ]
}
