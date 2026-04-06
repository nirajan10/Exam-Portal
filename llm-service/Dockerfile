FROM nvidia/cuda:12.1.1-devel-ubuntu22.04 AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-dev python3-pip \
    build-essential cmake ninja-build && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
# Build llama-cpp-python with CUDA support
ENV CMAKE_ARGS="-DGGML_CUDA=on"
ENV FORCE_CMAKE=1
# Stub libcuda.so for linking during build (real driver provided at runtime)
RUN ln -s /usr/local/cuda/lib64/stubs/libcuda.so /usr/local/cuda/lib64/stubs/libcuda.so.1
ENV LIBRARY_PATH=/usr/local/cuda/lib64/stubs:${LIBRARY_PATH}
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64/stubs:${LD_LIBRARY_PATH}
RUN pip3 install --no-cache-dir -r requirements.txt
# Remove the stub symlink so it doesn't interfere at runtime
RUN rm -f /usr/local/cuda/lib64/stubs/libcuda.so.1

FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 libgomp1 && \
    rm -rf /var/lib/apt/lists/*
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=builder /usr/lib/python3/dist-packages /usr/lib/python3/dist-packages
COPY --from=builder /usr/local/lib/python3.10 /usr/local/lib/python3.10
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .
VOLUME /app/models
EXPOSE 8000
RUN chmod +x start.sh
CMD ["./start.sh"]
