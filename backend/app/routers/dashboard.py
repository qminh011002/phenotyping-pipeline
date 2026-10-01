from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from app.database import AsyncSession, get_session
from app.deps import CurrentUser, get_analysis_service, get_dashboard_service
from app.schemas.analysis import DashboardOverview, DashboardStats
from app.services.analysis_service import AnalysisService
from app.services.dashboard_service import DashboardService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get(
    "/stats",
    response_model=DashboardStats,
    summary="Get dashboard aggregate statistics",
)
async def get_dashboard_stats(
    db: Annotated[AsyncSession, Depends(get_session)],
    user: CurrentUser,
    analysis_svc: AnalysisService = Depends(get_analysis_service),
) -> DashboardStats:
    """Return aggregate statistics for the home dashboard, scoped to the user.

    Includes total analyses, total images processed, total eggs counted,
    average confidence, average processing time, and the 5 most recent analyses.
    """
    return await analysis_svc.get_dashboard_stats(db=db, user_id=user.id)


@router.get(
    "/overview",
    response_model=DashboardOverview,
    summary="Dashboard analytics for a look-back window",
)
async def get_dashboard_overview(
    db: Annotated[AsyncSession, Depends(get_session)],
    user: CurrentUser,
    dashboard_svc: DashboardService = Depends(get_dashboard_service),
    days: int = Query(
        default=30,
        ge=0,
        le=3650,
        description="Look-back window in days; 0 = all time.",
    ),
    organism: Literal["egg", "larvae", "pupae", "neonate"] | None = Query(
        default=None, description="Restrict every metric to one organism."
    ),
) -> DashboardOverview:
    """KPIs (with the preceding period for comparison), throughput over time,
    organism mix, confidence and size distributions, per-batch comparison rows
    and the operator's outstanding work — all scoped to the caller.
    """
    return await dashboard_svc.get_overview(
        db=db, user_id=user.id, days=days, organism=organism
    )
