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
use unieai_session_mesh::unieai_task_tools as shared;
use unieai_session_mesh::unieai_task_tools::NoArgs;
use unieai_session_mesh::unieai_task_tools::PublishTaskArgs;
use unieai_session_mesh::unieai_task_tools::ReportTaskArgs;

pub(crate) struct PublishTaskHandler;
pub(crate) struct ClaimTaskHandler;
pub(crate) struct ReportTaskHandler;
pub(crate) struct ListTasksHandler;

// Names, descriptions, arguments and results are shared with the uac engine,
// which offers these tools through the TUI (see unieai_session_mesh).
fn string_schema(description: &str) -> JsonSchema {
    JsonSchema::string(Some(description.to_string()))
}

fn function_tool(
    name: &str,
    description: &str,
    properties: BTreeMap<String, JsonSchema>,
    required: Option<Vec<String>>,
) -> ToolSpec {
    ToolSpec::Function(ResponsesApiTool {
        name: name.to_string(),
        description: description.to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(properties, required, Some(false.into())),
        output_schema: None,
    })
}

pub fn create_publish_task_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "title".to_string(),
            string_schema(shared::TITLE_DESCRIPTION),
        ),
        ("body".to_string(), string_schema(shared::BODY_DESCRIPTION)),
        (
            "priority".to_string(),
            JsonSchema::number(Some(shared::PRIORITY_DESCRIPTION.to_string())),
        ),
        (
            "assign_to".to_string(),
            string_schema(shared::ASSIGN_TO_DESCRIPTION),
        ),
    ]);
    function_tool(
        shared::PUBLISH_TASK_TOOL,
        shared::PUBLISH_TASK_DESCRIPTION,
        properties,
        Some(vec!["title".to_string(), "body".to_string()]),
    )
}

pub fn create_claim_task_tool() -> ToolSpec {
    function_tool(
        shared::CLAIM_TASK_TOOL,
        shared::CLAIM_TASK_DESCRIPTION,
        BTreeMap::new(),
        /*required*/ None,
    )
}

pub fn create_report_task_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "task_id".to_string(),
            string_schema(shared::TASK_ID_DESCRIPTION),
        ),
        (
            "claim_token".to_string(),
            string_schema(shared::CLAIM_TOKEN_DESCRIPTION),
        ),
        (
            "status".to_string(),
            string_schema(shared::STATUS_DESCRIPTION),
        ),
        (
            "result".to_string(),
            string_schema(shared::RESULT_DESCRIPTION),
        ),
        (
            "error".to_string(),
            string_schema(shared::ERROR_DESCRIPTION),
        ),
    ]);
    function_tool(
        shared::REPORT_TASK_TOOL,
        shared::REPORT_TASK_DESCRIPTION,
        properties,
        Some(vec![
            "task_id".to_string(),
            "claim_token".to_string(),
            "status".to_string(),
        ]),
    )
}

pub fn create_list_tasks_tool() -> ToolSpec {
    function_tool(
        shared::LIST_TASKS_TOOL,
        shared::LIST_TASKS_DESCRIPTION,
        BTreeMap::new(),
        /*required*/ None,
    )
}

/// A shared task tool result as core's tool output (the result types live in
/// `unieai_session_mesh`, the trait in `codex_tools`).
struct TaskOutput<T> {
    result: T,
    name: &'static str,
    success: bool,
}

impl<T: serde::Serialize + Send + Sync> ToolOutput for TaskOutput<T> {
    fn log_output(&self) -> String {
        tool_output_json_text(&self.result, self.name)
    }

    fn success_for_logging(&self) -> bool {
        self.success
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        tool_output_response_item(
            call_id,
            payload,
            &self.result,
            Some(self.success),
            self.name,
        )
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        tool_output_code_mode_result(&self.result, self.name)
    }
}

fn task_output<T>(result: T, name: &'static str, success: bool) -> TaskOutput<T> {
    TaskOutput {
        result,
        name,
        success,
    }
}

impl ToolExecutor<ToolInvocation> for PublishTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(shared::PUBLISH_TASK_TOOL)
    }

    fn spec(&self) -> ToolSpec {
        create_publish_task_tool()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let args: PublishTaskArgs = parse_arguments(&arguments)?;

            let node = mesh_node(&session.services).await?;
            let result = shared::publish_task(&node, args)
                .await
                .map_err(mesh_error)?;
            Ok(boxed_tool_output(task_output(
                result,
                shared::PUBLISH_TASK_TOOL,
                /*success*/ true,
            )))
        })
    }
}

impl ToolExecutor<ToolInvocation> for ClaimTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(shared::CLAIM_TASK_TOOL)
    }

    fn spec(&self) -> ToolSpec {
        create_claim_task_tool()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let _args: NoArgs = parse_arguments(&arguments)?;

            let node = mesh_node(&session.services).await?;
            let result = shared::claim_task(&node).await.map_err(mesh_error)?;
            Ok(boxed_tool_output(task_output(
                result,
                shared::CLAIM_TASK_TOOL,
                /*success*/ true,
            )))
        })
    }
}

impl ToolExecutor<ToolInvocation> for ReportTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(shared::REPORT_TASK_TOOL)
    }

    fn spec(&self) -> ToolSpec {
        create_report_task_tool()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let args: ReportTaskArgs = parse_arguments(&arguments)?;

            let node = mesh_node(&session.services).await?;
            let result = shared::report_task(&node, args).await.map_err(mesh_error)?;
            Ok(boxed_tool_output(task_output(
                result.clone(),
                shared::REPORT_TASK_TOOL,
                result.recorded,
            )))
        })
    }
}

impl ToolExecutor<ToolInvocation> for ListTasksHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(shared::LIST_TASKS_TOOL)
    }

    fn spec(&self) -> ToolSpec {
        create_list_tasks_tool()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let _args: NoArgs = parse_arguments(&arguments)?;

            let node = mesh_node(&session.services).await?;
            let result = shared::list_tasks(&node).await.map_err(mesh_error)?;
            Ok(boxed_tool_output(task_output(
                result,
                shared::LIST_TASKS_TOOL,
                /*success*/ true,
            )))
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
