from time import time

from fastapi import APIRouter

from ..schemas import DeployAccepted, DeployRequest

router = APIRouter(prefix="/ops", tags=["ops"])


@router.get("/deployments")
def list_deployments() -> list[dict]:
    # TODO: return deployment jobs from the orchestration layer.
    return []


@router.post("/deploy", response_model=DeployAccepted)
def deploy(payload: DeployRequest) -> DeployAccepted:
    # TODO: run the deployment template for project/env.
    _ = (payload.project, payload.env)
    return DeployAccepted(jobId=f"demo-{int(time() * 1000)}")
