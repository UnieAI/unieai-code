// Copyright (c) 2026 UnieAI. All rights reserved.

use crate::ConfigLayerSource;
use crate::ConfigLayerStack;
use crate::LoaderOverrides;
use crate::NoopThreadConfigLoader;
use crate::loader::load_config_layers_state;
use crate::loader::project_trust_key;
use crate::loader::tests::TestFileSystem;
use codex_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;
use std::path::PathBuf;
use tempfile::TempDir;
use toml::Value as TomlValue;

struct Fixture {
    _temp: TempDir,
    home: PathBuf,
    project: AbsolutePathBuf,
    overrides: LoaderOverrides,
}

impl Fixture {
    fn new() -> anyhow::Result<Self> {
        let temp = tempfile::tempdir()?;
        let home = temp.path().join("home");
        let project = AbsolutePathBuf::from_absolute_path(temp.path().join("project"))?;
        std::fs::create_dir_all(&home)?;
        std::fs::create_dir_all(project.join(".git"))?;
        let key = TomlValue::String(project_trust_key(project.as_path()));
        std::fs::write(
            home.join("config.toml"),
            format!("[projects.{key}]\ntrust_level = \"trusted\"\n"),
        )?;
        let mut overrides = LoaderOverrides::with_managed_config_path_for_tests(
            temp.path().join("managed_config.toml"),
        );
        overrides.system_config_path = Some(temp.path().join("system.toml"));
        Ok(Self {
            _temp: temp,
            home,
            project,
            overrides,
        })
    }

    fn write_project_config(&self, dir_name: &str, model: &str) -> anyhow::Result<()> {
        let dir = self.project.join(dir_name);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("config.toml"), format!("model = \"{model}\"\n"))?;
        Ok(())
    }

    async fn load(&self) -> anyhow::Result<ConfigLayerStack> {
        Ok(load_config_layers_state(
            &TestFileSystem,
            &self.home,
            Some(self.project.clone()),
            &[(
                "project_root_markers".into(),
                toml::Value::try_from([".git"])?,
            )],
            self.overrides.clone(),
            &NoopThreadConfigLoader,
        )
        .await?)
    }
}

fn project_layers(stack: &ConfigLayerStack) -> Vec<(AbsolutePathBuf, Option<TomlValue>)> {
    stack
        .layers_low_to_high()
        .filter_map(|layer| match &layer.name {
            ConfigLayerSource::Project { dot_codex_folder } => {
                Some((dot_codex_folder.clone(), layer.config.get("model").cloned()))
            }
            _ => None,
        })
        .collect()
}

fn model(value: &str) -> Option<TomlValue> {
    Some(TomlValue::String(value.to_string()))
}

#[tokio::test]
async fn project_config_loads_from_unieai_dir() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    fixture.write_project_config(".unieai", "unieai")?;

    let stack = fixture.load().await?;

    assert_eq!(
        project_layers(&stack),
        vec![(fixture.project.join(".unieai"), model("unieai"))]
    );
    assert_eq!(
        stack.effective_config().get("model").cloned(),
        model("unieai")
    );
    assert!(stack.startup_warnings().unwrap_or_default().is_empty());
    Ok(())
}

#[tokio::test]
async fn project_config_falls_back_to_legacy_codex_dir() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    fixture.write_project_config(".codex", "legacy")?;

    let stack = fixture.load().await?;

    assert_eq!(
        project_layers(&stack),
        vec![(fixture.project.join(".codex"), model("legacy"))]
    );
    assert_eq!(
        stack.effective_config().get("model").cloned(),
        model("legacy")
    );
    Ok(())
}

#[tokio::test]
async fn project_config_prefers_unieai_when_both_dirs_exist() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    fixture.write_project_config(".unieai", "unieai")?;
    fixture.write_project_config(".codex", "legacy")?;

    let stack = fixture.load().await?;

    assert_eq!(
        project_layers(&stack),
        vec![(fixture.project.join(".unieai"), model("unieai"))]
    );
    assert_eq!(
        stack.effective_config().get("model").cloned(),
        model("unieai")
    );
    let warnings = stack.startup_warnings().unwrap_or_default();
    assert_eq!(warnings.len(), 1, "unexpected warnings: {warnings:?}");
    assert!(
        warnings[0].contains(".codex") && warnings[0].contains("only"),
        "unexpected warning: {}",
        warnings[0]
    );
    Ok(())
}

#[tokio::test]
async fn empty_unieai_dir_still_shadows_legacy_codex_dir() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    std::fs::create_dir_all(fixture.project.join(".unieai"))?;
    fixture.write_project_config(".codex", "legacy")?;

    let stack = fixture.load().await?;

    assert_eq!(
        project_layers(&stack),
        vec![(fixture.project.join(".unieai"), None)]
    );
    assert_eq!(stack.effective_config().get("model").cloned(), None);
    Ok(())
}
