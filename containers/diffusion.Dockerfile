# syntax=docker/dockerfile:1.7
#
# LocalMax diffusion benchmark image.
#
# Text-to-image only in v1. The pipeline is driven in-process rather than behind an HTTP
# server: a denoising step is the unit of work here, and interposing a request layer would
# add noise comparable to the quantity being measured.

ARG BASE_IMAGE=ghcr.io/pavel4ai/localmax-base:0.1.0
FROM ${BASE_IMAGE} AS runtime

USER root

ARG TARGETARCH
ARG TORCH_VERSION=2.6.0
ARG DIFFUSERS_VERSION=0.32.2
ARG CUDA_CHANNEL=cu126

ENV LOCALMAX_RUNTIME=diffusers \
    LOCALMAX_RUNTIME_VERSION=${DIFFUSERS_VERSION}

RUN --mount=type=cache,target=/root/.cache/pip \
    set -eux; \
    if [ "${TARGETARCH}" = "amd64" ]; then \
        pip install --no-cache-dir --index-url "https://download.pytorch.org/whl/${CUDA_CHANNEL}" \
            "torch==${TORCH_VERSION}"; \
    else \
        # aarch64 CUDA wheels come from the default index on recent releases.
        pip install --no-cache-dir "torch==${TORCH_VERSION}"; \
    fi

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir \
        "diffusers==${DIFFUSERS_VERSION}" \
        "transformers>=4.45" \
        "accelerate>=1.0" \
        "safetensors>=0.4" \
        "sentencepiece>=0.2" \
        "protobuf>=4.25" \
        "pillow>=10.4"

USER localmax

LABEL org.opencontainers.image.title="LocalMax diffusion benchmark" \
      org.opencontainers.image.description="Runs a pinned text-to-image diffusion benchmark profile on local NVIDIA hardware."

ENTRYPOINT ["localmax"]
CMD ["doctor"]
