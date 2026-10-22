import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request

from app.api.auth import router as auth_router
from app.api.admin_users import router as admin_users_router
from app.api.data_sources import router as data_sources_router
from app.api.data_foundation import router as data_foundation_router
from app.api.health import router as health_router
from app.api.workbooks import router as workbooks_router
from app.core.config import get_settings

settings = get_settings()

# Uvicorn's default logging configuration leaves the root logger without a
# handler, so explicitly enable the application's redacted auth milestones.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logging.getLogger("app").setLevel(logging.INFO)

app = FastAPI(title="Redes Painéis API", version="0.1.0")


@app.middleware("http")
async def redact_feishu_callback_query(request: Request, call_next):
    try:
        return await call_next(request)
    finally:
        if request.url.path == "/api/auth/feishu/callback":
            request.scope["query_string"] = b""

@app.middleware("http")
async def guard_doomsday_revision(request: Request, call_next):
    if request.method != "GET" or not request.url.path.startswith("/api/v2/"):
        return await call_next(request)
    from app.services.data_foundation.mapping_revision import request_revision, read_revision
    from app.services.data_foundation.repository import DataFoundationError
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool
    from sqlalchemy.exc import SQLAlchemyError
    import uuid
    expected = request.headers.get("X-Doomsday-Revision")
    if expected:
        try:
            uuid.UUID(expected.split(":", 1)[0])
            if len(expected) > 101:
                raise ValueError()
        except ValueError:
            return JSONResponse({"detail":"mapping_revision_invalid"},status_code=400)
    context = {"expected":expected,"observed":None}
    token = request_revision.set(context)
    try:
        response = await call_next(request)
        if context["observed"]:
            response.headers["X-Doomsday-Revision"] = context["observed"]
        if context["observed"] and response.status_code < 400 and not (context.get("validated") and request.url.path.endswith("/records")):
            from app.api.data_foundation import _engine
            try:
                current = await run_in_threadpool(read_revision, _engine())
                if current["revision"] != context["observed"]:
                    return JSONResponse({"detail":"mapping_revision_changed"},status_code=409,headers={"X-Doomsday-Revision":str(current["revision"])})
            except DataFoundationError as error:
                return JSONResponse({"detail":error.code},status_code=error.status_code)
            except SQLAlchemyError:
                return JSONResponse({"detail":"data_store_unavailable"},status_code=503)
            response.headers["X-Doomsday-Revision"] = context["observed"]
        return response
    finally:
        request_revision.reset(token)


if settings.app_env == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[str(settings.frontend_base_url).rstrip("/")],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Doomsday-Revision"],
        expose_headers=["X-Doomsday-Revision"],
    )

app.include_router(health_router, prefix="/api")
app.include_router(auth_router, prefix="/api/auth")
app.include_router(admin_users_router, prefix="/api")
app.include_router(data_sources_router, prefix="/api")
app.include_router(data_foundation_router, prefix="/api")
app.include_router(workbooks_router, prefix="/api")
