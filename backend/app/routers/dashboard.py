from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.database import AsyncSession, get_session
from app.deps import get_analysis_service
from app.schemas.analysis import DashboardStats
from app.services.analysis_service import AnalysisService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get(
    "/stats",
    response_model=DashboardStats,
    summary="Get dashboard aggregate statistics",
)
async def get_dashboard_stats(
    db: Annotated[AsyncSession, Depends(get_session)],
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> DashboardStats:
    """Return aggregate statistics for the home dashboard.

    Includes total analyses, total images processed, total eggs counted,
    average confidence, average processing time, and the 5 most recent analyses.
    """
    return await analysis_svc.get_dashboard_stats(db=db)
