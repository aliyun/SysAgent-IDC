from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import agents, devices, gpu, health, logs, ops

app = FastAPI(
    title="SysAgent管家 API",
    version="0.1.0",
    description="Frontend shell contract. Business logic is stubbed; demo payloads mirror the bundled mock adapter.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["sysom://app"],
    allow_origin_regex=r"^http://(127\.0\.0\.1|localhost):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (health, devices, gpu, agents, ops, logs):
    app.include_router(module.router, prefix="/api")


@app.get("/api/healthz")
def healthz() -> dict:
    return {"ok": True}
