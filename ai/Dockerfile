# LeRobot 데이터셋 변환 도구 (CPU면 충분). GB10(arm64)·x86 공용
# 학습(SmolVLA 등)은 GPU가 필요하므로 NGC PyTorch 이미지 기반으로 따로 만든다
FROM python:3.12
# torchcodec(영상 디코딩)이 시스템 FFmpeg 공유 라이브러리를 쓴다
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.10.0 torchvision==0.25.0
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /ai
