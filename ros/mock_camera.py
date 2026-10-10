"""모의 카메라: 카메라 없이 개발·시연할 때 (모의 팔처럼). 로봇 프로파일의 mock_camera: true 이면 bringup이 띄운다.

작업대 위에 부품이 몇 초마다 놓였다 치워지는 장면을 그려서 camera_topic으로 보낸다
→ 웹 카메라 탭의 실시간 화면, AI 비전 판단("부품이 있나요?"), 에피소드 녹화를 하드웨어 없이 확인.
토픽 이름이 .../compressed 이면 CompressedImage(JPEG), 아니면 Image(rgb8).
"""
import array
import io
import time

import numpy as np
import rclpy
from PIL import Image as PILImage, ImageDraw
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from sensor_msgs.msg import CompressedImage, Image

W, H = 480, 320
PERIOD = 8.0  # 초: 앞 절반은 부품 있음, 뒤 절반은 없음


def scene(t):
    img = PILImage.new('RGB', (W, H), (58, 62, 70))
    d = ImageDraw.Draw(img)
    d.polygon([(40, 300), (440, 300), (380, 150), (100, 150)], fill=(150, 140, 120))  # 작업대
    d.rectangle([300, 190, 400, 260], outline=(40, 40, 40), width=4)  # 오른쪽 상자
    if (t % PERIOD) < PERIOD / 2:  # 부품 (빨간 블록)
        x = 170 + 20 * np.sin(t)
        d.rectangle([x, 205, x + 50, 245], fill=(200, 40, 40), outline=(90, 10, 10), width=2)
    d.text((10, 8), f'MOCK CAMERA  {time.strftime("%H:%M:%S")}', fill=(230, 230, 230))
    return img


class MockCamera(Node):
    def __init__(self):
        super().__init__('mock_camera')
        self.topic = self.declare_parameter('topic', '/camera/color/image_raw/compressed').value
        fps = self.declare_parameter('fps', 10.0).value
        self.compressed = self.topic.rstrip('/').endswith('compressed')
        self.pub = self.create_publisher(CompressedImage if self.compressed else Image, self.topic, 10)
        self.t0 = time.monotonic()
        self.create_timer(1.0 / fps, self.tick)
        self.get_logger().info(f'모의 카메라: {self.topic} ({"JPEG" if self.compressed else "rgb8"}, {W}x{H}, {fps}fps)')

    def tick(self):
        img = scene(time.monotonic() - self.t0)
        stamp = self.get_clock().now().to_msg()
        if self.compressed:
            buf = io.BytesIO()
            img.save(buf, 'JPEG', quality=80)
            m = CompressedImage(format='jpeg', data=array.array('B', buf.getvalue()))  # array: rclpy가 바이트마다 타입 검사를 하지 않음
        else:
            m = Image(height=H, width=W, encoding='rgb8', step=W * 3, data=array.array('B', np.asarray(img).tobytes()))
        m.header.stamp = stamp
        m.header.frame_id = 'camera'
        self.pub.publish(m)


def main():
    rclpy.init()
    try:
        rclpy.spin(MockCamera())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
