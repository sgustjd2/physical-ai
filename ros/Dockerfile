# ROS2 Jazzy (Ubuntu 24.04) — 공식 이미지가 arm64(GB10)와 amd64를 모두 제공
FROM ros:jazzy-ros-base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-jazzy-rosbridge-suite ros-jazzy-control-msgs \
    && rm -rf /var/lib/apt/lists/*
# 코드는 이미지에 굽지 않고 docker-compose에서 ./ros 를 /ros 로 마운트 → 수정 후 restart만 하면 됨
CMD ["ros2", "launch", "/ros/bringup.launch.py"]
