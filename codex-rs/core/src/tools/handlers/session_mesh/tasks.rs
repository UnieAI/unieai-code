//! Work-queue tools: publish, claim, report, list.
//!
//! The queue is how sessions divide work without one of them having to stay
//! attached to the others. A claim is exclusive and a report is idempotent, so
//! a session that dies mid-task returns it to the pool rather than losing it,
//! and the session that wakes up afterwards is told its claim is gone instead
//! of quietly overwriting whoever finished the job.

use super::*;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use std::collections::BTreeMap;

const DEFAULT_QUEUE: &str = "default";
const TASK_LIST_LIMIT: i64 = 50;

pub(crate) struct PublishTaskHandler;
pub(crate) struct ClaimTaskHandler;
pub(crate) struct ReportTaskHandler;
pub(crate) struct ListTasksHandler;

pub fn create_publish_task_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "title".to_string(),
            JsonSchema::string(Some("Short summary of the work.".to_string())),
        ),
        (
            "body".to_string(),
            JsonSchema::string(Some(
                "Everything the claiming session needs to do the work without asking you."
                    .to_string(),
            )),
        ),
        (
            "priority".to_string(),
            JsonSchema::number(Some("Higher is claimed first. Defaults to 0.".to_string())),
        ),
        (
            "assign_to".to_string(),
            JsonSchema::string(Some(
                "Optional peer handle from list_peers. An assigned task can only be claimed by \
that session, and is offered to it ahead of open work."
                    .to_string(),
            )),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "publish_task".to_string(),
        description: "Publish work to the machine-local queue for another UnieAI Code session to \
pick up. Returns the task id."
            .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec!["title".to_string(), "body".to_string()]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}

pub fn create_claim_task_tool() -> ToolSpec {
    ToolSpec::Function(ResponsesApiTool {
        name: "claim_task".to_string(),
        description: "Claim the next task from the machine-local queue. Returns the task and a \
claim token; pass that token to report_task when you finish. Returns nothing when the queue is \
empty. Tasks assigned to this session are offered first."
            .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(BTreeMap::new(), /*required*/ None, Some(false.into())),
        output_schema: None,
    })
}

pub fn create_report_task_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "task_id".to_string(),
            JsonSchema::string(Some("Task id from claim_task.".to_string())),
        ),
        (
            "claim_token".to_string(),
            JsonSchema::string(Some("Claim token from claim_task.".to_string())),
        ),
        (
            "status".to_string(),
            JsonSchema::string(Some("`done` or `failed`.".to_string())),
        ),
        (
            "result".to_string(),
            JsonSchema::string(Some(
                "What you produced, for the session that published the task.".to_string(),
            )),
        ),
        (
            "error".to_string(),
            JsonSchema::string(Some("Why it failed, when it failed.".to_string())),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "report_task".to_string(),
        description:
            "Report the outcome of a task you claimed. If your claim expired because this \
session was considered gone, the report is refused and says so — stop working on that task rather \
than continuing."
                .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec![
                "task_id".to_string(),
                "claim_token".to_string(),
                "status".to_string(),
            ]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}

pub fn create_list_tasks_tool() -> ToolSpec {
    ToolSpec::Function(ResponsesApiTool {
        name: "list_tasks".to_string(),
        description: "List tasks on the machine-local queue with their status.".to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(BTreeMap::new(), /*required*/ None, Some(false.into())),
        output_schema: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishTaskArgs {
    title: String,
    body: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    assign_to: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportTaskArgs {
    task_id: String,
    claim_token: String,
    status: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PublishTaskResult {
    task_id: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ClaimTaskResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<ClaimedTask>,
}

#[derive(Debug, Serialize)]
struct ClaimedTask {
    task_id: String,
    claim_token: String,
    title: String,
    body: String,
    attempt: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportTaskResult {
    recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ListTasksResult {
    tasks: Vec<ListedTask>,
}

#[derive(Debug, Serialize)]
struct ListedTask {
    task_id: String,
    title: String,
    status: String,
    attempt_count: i64,
}

macro_rules! tool_output_impl {
    ($ty:ty, $name:literal, $success:expr) => {
        impl ToolOutput for $ty {
            fn log_preview(&self) -> String {
                tool_output_json_text(self, $name)
            }

            fn success_for_logging(&self) -> bool {
                #[allow(clippy::redundant_closure_call)]
                ($success)(self)
            }

            fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
                #[allow(clippy::redundant_closure_call)]
                let success = ($success)(self);
                tool_output_response_item(call_id, payload, self, Some(success), $name)
            }

            fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
                tool_output_code_mode_result(self, $name)
            }
        }
    };
}

tool_output_impl!(
    PublishTaskResult,
    "publish_task",
    |_: &PublishTaskResult| true
);
tool_output_impl!(ClaimTaskResult, "claim_task", |_: &ClaimTaskResult| true);
tool_output_impl!(
    ReportTaskResult,
    "report_task",
    |result: &ReportTaskResult| { result.recorded }
);
tool_output_impl!(ListTasksResult, "list_tasks", |_: &ListTasksResult| true);

impl ToolExecutor<ToolInvocation> for PublishTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("publish_task")
    }

    fn spec(&self) -> ToolSpec {
        create_publish_task_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let args: PublishTaskArgs = parse_arguments(&arguments)?;

            let node = mesh_node(&session.services).await?;

            // An assignment is resolved before publishing so a typo fails here
            // rather than parking work nobody can claim.
            let assigned_to = match args.assign_to.as_deref() {
                Some(handle) => Some(
                    node.resolve(&unieai_session_mesh::PeerSelector::new(handle))
                        .await
                        .map_err(mesh_error)?
                        .thread_id,
                ),
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
                .await
                .map_err(mesh_error)?;

            Ok(boxed_tool_output(PublishTaskResult { task_id }))
        })
    }
}

impl ToolExecutor<ToolInvocation> for ClaimTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("claim_task")
    }

    fn spec(&self) -> ToolSpec {
        create_claim_task_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let _args: NoArgs = parse_arguments(&arguments)?;

            let claimed = mesh_node(&session.services).await?
                .sender()
                .claim_task(DEFAULT_QUEUE)
                .await
                .map_err(mesh_error)?;

            Ok(boxed_tool_output(ClaimTaskResult {
                task: claimed.map(|(task, claim_token)| ClaimedTask {
                    task_id: task.task_id,
                    claim_token,
                    title: task.title,
                    body: task.body,
                    attempt: task.attempt_count,
                }),
            }))
        })
    }
}

impl ToolExecutor<ToolInvocation> for ReportTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("report_task")
    }

    fn spec(&self) -> ToolSpec {
        create_report_task_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let args: ReportTaskArgs = parse_arguments(&arguments)?;

            let outcome = mesh_node(&session.services).await?
                .sender()
                .report_task(
                    &args.task_id,
                    &args.claim_token,
                    &args.status,
                    args.result.as_deref(),
                    args.error.as_deref(),
                )
                .await
                .map_err(mesh_error)?;

            let recorded = outcome == codex_state::TaskReportOutcome::Recorded;
            Ok(boxed_tool_output(ReportTaskResult {
                recorded,
                note: (!recorded).then(|| {
                    "your claim expired and the task was reassigned; stop working on it".to_string()
                }),
            }))
        })
    }
}

impl ToolExecutor<ToolInvocation> for ListTasksHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("list_tasks")
    }

    fn spec(&self) -> ToolSpec {
        create_list_tasks_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let _args: NoArgs = parse_arguments(&arguments)?;

            let tasks = mesh_node(&session.services).await?
                .sender()
                .list_tasks(DEFAULT_QUEUE, TASK_LIST_LIMIT)
                .await
                .map_err(mesh_error)?;

            Ok(boxed_tool_output(ListTasksResult {
                tasks: tasks
                    .into_iter()
                    .map(|task| ListedTask {
                        task_id: task.task_id,
                        title: task.title,
                        status: task.status,
                        attempt_count: task.attempt_count,
                    })
                    .collect(),
            }))
        })
    }
}

macro_rules! core_runtime_impl {
    ($ty:ty) => {
        impl CoreToolRuntime for $ty {
            fn matches_kind(&self, payload: &ToolPayload) -> bool {
                matches!(payload, ToolPayload::Function { .. })
            }
        }
    };
}

core_runtime_impl!(PublishTaskHandler);
core_runtime_impl!(ClaimTaskHandler);
core_runtime_impl!(ReportTaskHandler);
core_runtime_impl!(ListTasksHandler);
