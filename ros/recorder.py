"""에피소드 녹화기: /episode/cmd 지시를 받아 rosbag2(mcap)로 녹화한다.

  /episode/cmd    ← {"op": "start", "id", "task", "meta": {...}} | {"op": "stop", "id", "result"}
  /episode/status → {"recording", "current", "episodes": [최근 20개 요약], "ack": 처리한 cmd id, "error"}

저장 위치: <data_dir>/<YYYYmmdd-HHMMSS-mmm>_<작업>/
  bag/          rosbag2 (mcap). `ros2 bag info`, Foxglove, LeRobot 변환의 입력
  episode.json  작업 설명(지시문), 결과, 로봇, 토픽, 시각, 워크플로
  record.log    ros2 bag record 출력
"""
import json
import re
import signal
import subprocess
import time
from datetime import datetime
from pathlib import Path

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import String

LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
BAG_NODE = 'episode_bag'
SUMMARY = ('name', 'task', 'result', 'duration', 'started')


def now_iso():
    return datetime.now().astimezone().isoformat(timespec='milliseconds')


class Recorder(Node):
    def __init__(self):
        super().__init__('episode_recorder')
        default_dir = Path(__file__).resolve().parent.parent / 'data' / 'episodes'
        self.data_dir = Path(self.declare_parameter('data_dir', str(default_dir)).value)
        self.topics = list(self.declare_parameter('topics', ['/joint_states']).value)
        self.robot = self.declare_parameter('robot', '').value
        self.proc = None
        self.current = None
        self.pub = self.create_publisher(String, '/episode/status', LATCHED)
        self.create_subscription(String, '/episode/cmd', self.on_cmd, 10)
        self.create_timer(1.0, self.watch)
        self.mark_interrupted()
        self.get_logger().info(f'녹화 위치 {self.data_dir}, 토픽 {self.topics}')
        self.publish()

    def publish(self, ack=None, error=''):
        data = {'recording': self.proc is not None, 'current': self.current,
                'episodes': self.recent(), 'ack': ack, 'error': error}
        self.pub.publish(String(data=json.dumps(data, ensure_ascii=False)))

    def recent(self, n=20):
        out = []
        for p in sorted(self.data_dir.glob('*/episode.json'), reverse=True)[:n]:
            try:
                e = json.loads(p.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            out.append({k: e.get(k) for k in SUMMARY})
        return out

    def mark_interrupted(self):
        """전원 차단 등으로 마무리 못 한 에피소드 표시 (학습 데이터에서 걸러내도록). bag은 `ros2 bag reindex`로 복구 가능"""
        for p in self.data_dir.glob('*/episode.json'):
            try:
                e = json.loads(p.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            if 'result' not in e:
                e.pop('t0', None)
                p.write_text(json.dumps({**e, 'result': 'interrupted'}, ensure_ascii=False, indent=2), encoding='utf-8')

    def on_cmd(self, msg):
        cmd = {}
        try:
            cmd = json.loads(msg.data)
            {'start': self.start, 'stop': self.stop}[cmd['op']](cmd)
            self.publish(ack=cmd.get('id'))
        except Exception as e:  # noqa: BLE001 — 실패 이유를 요청자에게 돌려준다
            self.get_logger().error(f'{cmd.get("op")}: {e!r}')
            self.publish(ack=cmd.get('id'), error=str(e))

    def start(self, cmd):
        if self.proc:
            raise RuntimeError(f'이미 녹화 중: {self.current["name"]}')
        task = cmd.get('task', '')
        slug = re.sub(r'[^\w-]+', '_', task).strip('_')[:40]
        name = datetime.now().strftime('%Y%m%d-%H%M%S-%f')[:-3] + (f'_{slug}' if slug else '')
        d = self.data_dir / name
        d.mkdir(parents=True)
        self.current = {'id': cmd.get('id'), 'name': name, 'task': task, 'robot': self.robot,
                        'topics': self.topics, 'started': now_iso(), 't0': time.time(), **cmd.get('meta', {})}
        with open(d / 'record.log', 'w') as log:
            self.proc = subprocess.Popen(
                ['ros2', 'bag', 'record', '-s', 'mcap', '-o', str(d / 'bag'), '--node-name', BAG_NODE,
                 '--topics', *self.topics], stdout=log, stderr=subprocess.STDOUT)
        self.write()
        try:
            self.wait_subscribed()
        except Exception:
            self.stop({'result': 'failed_to_start'})
            raise

    def wait_subscribed(self, timeout=10):
        """녹화기가 지금 존재하는 대상 토픽을 실제로 구독할 때까지 기다린다. 그 전의 동작은 녹화되지 않기 때문."""
        existing = {t for t, _ in self.get_topic_names_and_types()} & set(self.topics)
        t_end = time.monotonic() + timeout
        while time.monotonic() < t_end:
            if self.proc.poll() is not None:
                raise RuntimeError('ros2 bag record 가 바로 종료됨 (record.log 확인)')
            if all(any(i.node_name == BAG_NODE for i in self.get_subscriptions_info_by_topic(t)) for t in existing):
                return
            time.sleep(0.1)
        raise TimeoutError(f'{timeout}초 안에 녹화 구독이 준비되지 않음')

    def stop(self, cmd):
        if not self.proc:
            raise RuntimeError('녹화 중이 아님')
        self.proc.send_signal(signal.SIGINT)  # rosbag2는 SIGINT를 받으면 파일을 정상 마무리한다
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.finish(cmd.get('result', ''))

    def finish(self, result):
        c = self.current
        c.update(result=result, ended=now_iso(), duration=round(time.time() - c.pop('t0'), 3))
        self.write()
        self.proc = self.current = None

    def write(self):
        path = self.data_dir / self.current['name'] / 'episode.json'
        path.write_text(json.dumps(self.current, ensure_ascii=False, indent=2), encoding='utf-8')

    def watch(self):
        if self.proc and self.proc.poll() is not None:
            self.finish('recorder_died')
            self.publish(error='ros2 bag record 가 예기치 않게 종료됨 (record.log 확인)')


def main():
    rclpy.init()
    node = Recorder()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        if node.proc:  # 종료 시 녹화 중이던 에피소드를 마무리
            node.stop({'result': 'shutdown'})


if __name__ == '__main__':
    main()
