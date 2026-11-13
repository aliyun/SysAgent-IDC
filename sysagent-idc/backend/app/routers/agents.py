from fastapi import APIRouter

from ..schemas import Accepted

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("")
def get_agent_status() -> dict:
    # TODO: read OpenClaw/Gateway worker state and session statistics.
    return {"status": "placeholder", "sessions": [], "processes": []}


@router.post("/{agent_id}/restart", response_model=Accepted)
def restart_agent(agent_id: str) -> Accepted:
    # TODO: trigger the controlled restart policy for agent_id.
    _ = agent_id
    return Accepted()
