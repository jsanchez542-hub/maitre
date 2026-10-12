"""The developer's call page, served with the Worker's API on the same origin, so no CORS is needed.

    uv run python dev/serve.py      # then open http://127.0.0.1:8790

The page opens a demo restaurant on the local Worker and calls it through
LiveKit, with the voice agent running on this machine (python -m maitre_voice.agent dev).
"""

from __future__ import annotations

from pathlib import Path

import aiohttp
from aiohttp import web

WORKER = "http://127.0.0.1:8787"
PAGE = Path(__file__).with_name("call.html")
PORT = 8790


async def page(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(PAGE, headers={"cache-control": "no-store"})


async def api(request: web.Request) -> web.StreamResponse:
    """Passes /v1/... to the local Worker, as the site's own origin does in production."""
    async with aiohttp.ClientSession() as http:
        body = await request.read()
        headers = {"content-type": request.headers.get("content-type", "application/json")}
        async with http.request(request.method, f"{WORKER}{request.rel_url}", data=body or None, headers=headers) as upstream:
            response = web.StreamResponse(
                status=upstream.status, headers={"content-type": upstream.headers.get("content-type", "application/json")}
            )
            await response.prepare(request)
            async for chunk in upstream.content.iter_any():
                await response.write(chunk)
            await response.write_eof()
            return response


def main() -> None:
    app = web.Application()
    app.router.add_get("/", page)
    app.router.add_route("*", "/v1/{tail:.*}", api)
    print(f"Call page on http://127.0.0.1:{PORT} (the Worker must be on {WORKER})")
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()
