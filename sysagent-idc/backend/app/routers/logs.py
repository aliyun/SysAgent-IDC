from fastapi import APIRouter

from .. import demo_data

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("/entries")
def list_entries() -> list[dict]:
    return demo_data.LOG_ENTRIES


@router.get("/tasks")
def list_tasks() -> list[dict]:
    # TODO: return real aggregation tasks and their checkpoints.
    return []
