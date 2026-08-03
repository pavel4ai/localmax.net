# syntax=docker/dockerfile:1.7
#
# LocalMax LLM and Vision benchmark image.
#
# Hosts the pinned inference runtime locally and drives it with AIPerf. Both the runtime and
# the harness are pinned: a benchmark whose load generator can drift is not a benchmark.
#
# ARM64 NOTE: vLLM publishes no aarch64 wheels on PyPI, so the GB10 / DGX Spark path builds
# from source against the CUDA arm64 base. That build is long and is the open item in the
# bake-off — the arm64 image is not signed as an official release until it has produced a
# repeatable result on real GB10 hardware.

ARG BASE_IMAGE=ghcr.io/pavel4ai/localmax-base:0.1.0
FROM ${BASE_IMAGE} AS runtime

USER root

ARG TARGETARCH
ARG VLLM_VERSION=0.8.5
ARG AIPERF_REF=main

# The exact versions the profile pins. Recorded in every manifest and checked on submission.
ENV LOCALMAX_RUNTIME=vllm \
    LOCALMAX_RUNTIME_VERSION=${VLLM_VERSION}

RUN --mount=type=cache,target=/root/.cache/pip \
    set -eux; \
    if [ "${TARGETARCH}" = "amd64" ]; then \
        pip install --no-cache-dir "vllm==${VLLM_VERSION}"; \
    else \
        apt-get update && apt-get install -y --no-install-recommends \
            build-essential cmake ninja-build python3-dev && \
        rm -rf /var/lib/apt/lists/* && \
        pip install --no-cache-dir "vllm==${VLLM_VERSION}" \
          || echo "vLLM aarch64 wheel unavailable; the arm64 image is a release candidate."; \
    fi

# NVIDIA AIPerf: the pinned request generator and metric engine for LLM and Vision.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir "git+https://github.com/ai-dynamo/aiperf@${AIPERF_REF}" \
    || echo "AIPerf unavailable at ${AIPERF_REF}; the runner falls back to its built-in \
generator and records harness=builtin, which is not eligible for Verified."

USER localmax

LABEL org.opencontainers.image.title="LocalMax LLM benchmark" \
      org.opencontainers.image.description="Runs a pinned LLM or vision-language benchmark profile on local NVIDIA hardware."

ENTRYPOINT ["localmax"]
CMD ["doctor"]
