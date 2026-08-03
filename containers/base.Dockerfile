# syntax=docker/dockerfile:1.7
#
# Shared LocalMax runner base.
#
# Multi-architecture from the start: DGX Spark is GB10/aarch64, and retrofitting arm64 onto
# an amd64-only image line later would mean rebuilding and re-signing every release.
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f containers/base.Dockerfile .

ARG CUDA_VERSION=12.8.1
ARG UBUNTU_VERSION=24.04

FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION} AS base

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETPLATFORM
ARG LOCALMAX_VERSION=0.1.0

LABEL org.opencontainers.image.source="https://github.com/pavel4ai/localmax.net" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="LocalMax" \
      org.opencontainers.image.title="LocalMax runner base" \
      org.opencontainers.image.version="${LOCALMAX_VERSION}"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/cache/huggingface \
    LOCALMAX_HOME=/cache \
    LOCALMAX_PROFILES=/opt/localmax/profiles \
    LOCALMAX_ASSETS=/opt/localmax/assets \
    LOCALMAX_SCHEMAS=/opt/localmax/schemas

RUN python3 -m venv $VIRTUAL_ENV && pip install --no-cache-dir --upgrade pip

WORKDIR /opt/localmax

# Dependencies first so a source change does not invalidate the wheel layer.
COPY pyproject.toml README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir . huggingface_hub

# Pinned benchmark inputs. These are part of the measurement, so they ship in the image and
# their hashes are recorded in the profile rather than fetched at run time.
COPY benchmarks/profiles /opt/localmax/profiles
COPY benchmarks/assets /opt/localmax/assets
COPY schemas /opt/localmax/schemas

# Unprivileged. The runner needs the GPU and the cache mount, nothing else.
RUN useradd --create-home --uid 10001 localmax \
    && mkdir -p /cache && chown -R localmax:localmax /cache /opt/localmax
USER localmax

VOLUME ["/cache"]

ENTRYPOINT ["localmax"]
CMD ["doctor"]
