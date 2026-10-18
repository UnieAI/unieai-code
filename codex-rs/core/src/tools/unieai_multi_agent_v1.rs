// Copyright (c) 2026 UnieAI. All rights reserved.
//! Offers the Multi-Agent V1 tools individually to providers without the
//! `{"type":"namespace"}` extension.
//!
//! V1 builds its specs already wrapped in `multi_agent_v1`. A gateway that
//! implements the published Responses API (UnieAI's) advertises that container
//! to the model and then rejects every call into it, so the sub-agent tools
//! look available and are not. With `namespace_tools = false` the five tools
//! are unwrapped into plain functions, and their runtime names follow so the
//! calls the model makes route back to the same handlers.

use crate::session::session::Session;
use crate::tools::context::ToolInvocation;
use crate::tools::registry::CoreToolRuntime;
use codex_tools::ResponsesApiNamespaceTool;
use codex_tools::ToolExecutor;
use codex_tools::ToolExposure;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use futures::future::BoxFuture;
use std::sync::Arc;

/// `handler` as registered: unchanged when the provider understands
/// namespaces, else with its `multi_agent_v1` wrapper removed.
pub(super) fn multi_agent_v1_handler(
    handler: impl CoreToolRuntime + 'static,
    namespaced: bool,
) -> Arc<dyn CoreToolRuntime> {
    if namespaced {
        Arc::new(handler)
    } else {
        Arc::new(MultiAgentV1Flattened {
            handler: Arc::new(handler),
        })
    }
}

struct MultiAgentV1Flattened {
    handler: Arc<dyn CoreToolRuntime>,
}

impl ToolExecutor<ToolInvocation> for MultiAgentV1Flattened {
    fn tool_name(&self) -> ToolName {
        // The name moves in lockstep with the spec: a namespaced name would
        // advertise `spawn_agent` and then fail to route the model's call.
        ToolName::plain(self.handler.tool_name().name)
    }

    fn spec(&self) -> ToolSpec {
        match self.handler.spec() {
            ToolSpec::Namespace(namespace) => match namespace.tools.into_iter().next() {
                Some(ResponsesApiNamespaceTool::Function(tool)) => ToolSpec::Function(tool),
                _ => self.handler.spec(),
            },
            spec => spec,
        }
    }

    fn exposure(&self) -> ToolExposure {
        self.handler.exposure()
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.handler.supports_parallel_tool_calls()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        self.handler.handle(invocation)
    }
}

impl CoreToolRuntime for MultiAgentV1Flattened {
    fn wait_until_ready<'a>(&'a self, session: &'a Arc<Session>) -> Option<BoxFuture<'a, ()>> {
        self.handler.wait_until_ready(session)
    }

    fn matches_kind(&self, payload: &crate::tools::context::ToolPayload) -> bool {
        self.handler.matches_kind(payload)
    }

    fn create_diff_consumer(
        &self,
    ) -> Option<Box<dyn crate::tools::registry::ToolArgumentDiffConsumer>> {
        self.handler.create_diff_consumer()
    }
}
