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
ARG VLLM_VERSION=0.26.0
ARG AIPERF_VERSION=0.7.0

# The exact versions the profile pins. Recorded in every manifest and checked on submission.
ENV LOCALMAX_RUNTIME=vllm \
    LOCALMAX_RUNTIME_VERSION=${VLLM_VERSION}

RUN --mount=type=cache,target=/root/.cache/pip \
    set -eux; \
    if [ "${TARGETARCH}" != "amd64" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            build-essential cmake ninja-build python3-dev && \
        rm -rf /var/lib/apt/lists/*; \
    fi; \
    pip install --no-cache-dir "vllm==${VLLM_VERSION}"

# NVIDIA AIPerf: the pinned request generator and metric engine for LLM and Vision.
# Not optional in a released image. The runner has a built-in generator so a source
# checkout still works, but a result produced that way records harness=builtin and is
# never eligible for Verified — so an official image that quietly lacked AIPerf would
# publish unrankable results with no indication why. Pinned to a release, not a git ref:
# a load generator that can change under the benchmark is not a pinned benchmark.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir "aiperf==${AIPERF_VERSION}"

USER localmax

LABEL org.opencontainers.image.title="LocalMax LLM benchmark" \
      org.opencontainers.image.description="Runs a pinned LLM or vision-language benchmark profile on local NVIDIA hardware."

ENTRYPOINT ["localmax"]
CMD ["doctor"]
