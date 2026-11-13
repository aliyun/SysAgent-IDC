from fastapi import APIRouter

from .. import demo_data
from ..schemas import Accepted, OptimizeRequest

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/snapshot")
def get_snapshot() -> dict:
    return demo_data.health_snapshot()


@router.post("/scan", response_model=Accepted)
def run_scan() -> Accepted:
    # TODO: enqueue a real inspection run.
    return Accepted()


@router.post("/optimize", response_model=Accepted)
def run_optimize(payload: OptimizeRequest) -> Accepted:
    # TODO: apply the requested optimizations.
    _ = payload.items
    return Accepted()
