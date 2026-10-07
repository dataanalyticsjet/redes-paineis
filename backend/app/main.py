import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request

from app.api.auth import router as auth_router
from app.api.admin_users import router as admin_users_router
from app.api.data_sources import router as data_sources_router
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

if settings.app_env == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[str(settings.frontend_base_url).rstrip("/")],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.include_router(health_router, prefix="/api")
app.include_router(auth_router, prefix="/api/auth")
app.include_router(admin_users_router, prefix="/api")
app.include_router(data_sources_router, prefix="/api")
app.include_router(workbooks_router, prefix="/api")
