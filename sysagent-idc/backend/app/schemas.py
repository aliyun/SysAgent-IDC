from typing import Literal

from pydantic import BaseModel, Field


class Accepted(BaseModel):
    ok: Literal[True] = True


class OptimizeRequest(BaseModel):
    items: list[str] = Field(default_factory=list)


class DeployRequest(BaseModel):
    project: str
    env: str


class DeployAccepted(BaseModel):
    jobId: str
