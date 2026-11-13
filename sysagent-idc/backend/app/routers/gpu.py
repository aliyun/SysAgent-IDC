from fastapi import APIRouter

from ..schemas import Accepted

router = APIRouter(prefix="/gpu", tags=["gpu"])


@router.get("")
def get_gpu_status() -> dict:
    # TODO: return live GPU inventory, utilization and health evidence.
    return {"status": "placeholder", "cards": [], "jobs": []}


@router.post("/{device_id}/scan", response_model=Accepted)
def run_gpu_scan(device_id: str) -> Accepted:
    # TODO: enqueue a GPU diagnostic scan for device_id.
    _ = device_id
    return Accepted()
