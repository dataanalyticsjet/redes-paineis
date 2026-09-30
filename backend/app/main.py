from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.core.config import get_settings

settings = get_settings()

app = FastAPI(title="Redes Painéis API", version="0.1.0")

if settings.app_env == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[str(settings.frontend_base_url).rstrip("/")],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.include_router(health_router, prefix="/api")
