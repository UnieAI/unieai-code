# Copyright (c) 2026 UnieAI. All rights reserved.
"""Harbor's Docker environment, on a pre-created network.

This host has used up Docker's default address pools, so ``docker compose up``
cannot create a ``<project>_default`` network. The runner creates one bridge
network per concurrency slot with an explicit subnet and exports a compose
overlay that makes it the project's (external) default network. Harbor drops
``--extra-docker-compose`` for separate verifier environments, so the overlay
is appended here instead, for every compose project a trial starts (agent
environment and verifier environment alike).

Use with ``harbor run -e unieai_env:UnieaiDockerEnvironment`` and
``UNIEAI_BENCH_NETWORK_OVERLAY=<overlay.json>`` in the environment.
"""

from __future__ import annotations

import os
from pathlib import Path

from harbor.environments.docker.docker import DockerEnvironment

OVERLAY_ENV = "UNIEAI_BENCH_NETWORK_OVERLAY"


class UnieaiDockerEnvironment(DockerEnvironment):
    @property
    def _docker_compose_paths(self) -> list[Path]:
        paths = list(super()._docker_compose_paths)
        overlay = os.environ.get(OVERLAY_ENV)
        if overlay:
            paths.append(Path(overlay))
        return paths
