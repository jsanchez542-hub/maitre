# The voice agent as it runs on a server: dependencies from the lock file, the models it runs itself downloaded
# at build time so a call never waits for them, and a user without privileges. It opens no port: it reaches
# LiveKit, the speech providers and the Worker, and nothing reaches it.
FROM python:3.15-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.11.8 /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    HF_HOME=/app/models \
    PATH=/app/.venv/bin:$PATH

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin maitre
WORKDIR /app

COPY pyproject.toml uv.lock .python-version README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev \
    && python -m maitre_voice.agent download-files \
    && chown -R maitre:maitre /app

USER maitre
CMD ["python", "-m", "maitre_voice.agent", "start"]
