from fastapi import APIRouter

from .. import demo_data

router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("")
def list_devices() -> list[dict]:
    return demo_data.DEVICES
