from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from .database import IdempotencyRecord

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class IdempotencyMiddleware(BaseHTTPMiddleware):
    """Require and persist an idempotency result for every API mutation."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)
        self._key_locks: dict[str, asyncio.Lock] = {}
        self._key_locks_guard = asyncio.Lock()

    async def _lock_for(self, key: str) -> asyncio.Lock:
        async with self._key_locks_guard:
            return self._key_locks.setdefault(key, asyncio.Lock())

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if request.method not in WRITE_METHODS or not request.url.path.startswith("/api/v1"):
            return await call_next(request)
        key = (request.headers.get("Idempotency-Key") or "").strip()
        if not key:
            return JSONResponse(
                status_code=400,
                content={"detail": "Idempotency-Key header is required for write requests"},
            )
        if len(key) > 200:
            return JSONResponse(status_code=400, content={"detail": "Idempotency-Key is too long"})
        lock = await self._lock_for(key)
        async with lock:
            return await self._dispatch_locked(request, call_next, key)

    async def _dispatch_locked(
        self,
        request: Request,
        call_next: Callable,
        key: str,
    ) -> Response:
        """Run the lookup, mutation, and response insert under one per-key lock."""

        body = await request.body()
        fingerprint_source = b"\n".join(
            [
                request.method.encode("utf-8"),
                request.url.path.encode("utf-8"),
                request.url.query.encode("utf-8"),
                (request.headers.get("content-type") or "").encode("utf-8"),
                body,
            ]
        )
        fingerprint = hashlib.sha256(fingerprint_source).hexdigest()
        database = request.app.state.database
        with database.session() as session:
            existing = session.get(IdempotencyRecord, key)
            if existing:
                if (
                    existing.method != request.method
                    or existing.path != request.url.path
                    or existing.request_sha256 != fingerprint
                ):
                    return JSONResponse(
                        status_code=409,
                        content={"detail": "Idempotency-Key was already used for another request"},
                    )
                return Response(
                    content=existing.response_body,
                    status_code=existing.status_code,
                    media_type=existing.content_type.split(";", 1)[0],
                    headers={"Idempotency-Replayed": "true"},
                )

        response = await call_next(request)
        chunks = [chunk async for chunk in response.body_iterator]
        response_body = b"".join(chunks)
        content_type = response.headers.get("content-type", "application/json")
        if response.status_code < 500:
            try:
                with database.session() as session:
                    session.add(
                        IdempotencyRecord(
                            key=key,
                            method=request.method,
                            path=request.url.path,
                            request_sha256=fingerprint,
                            status_code=response.status_code,
                            response_body=response_body,
                            content_type=content_type,
                        )
                    )
            except IntegrityError:
                # A concurrent identical request won the insert. Its committed
                # domain mutation is already protected by SQLite serialization.
                pass
        headers = {
            name: value
            for name, value in response.headers.items()
            if name.lower() not in {"content-length", "content-type"}
        }
        headers["Idempotency-Replayed"] = "false"
        return Response(
            content=response_body,
            status_code=response.status_code,
            media_type=content_type.split(";", 1)[0],
            headers=headers,
        )
