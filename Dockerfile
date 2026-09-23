FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY static/ static/

ARG VERSION=unknown
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/bdelima/ha-portainer-sidecar" \
      org.opencontainers.image.url="https://github.com/bdelima/ha-portainer-sidecar" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV APP_VERSION="${VERSION}"

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
