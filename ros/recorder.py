"""에피소드 녹화기: /episode/cmd 지시를 받아 rosbag2(mcap)로 녹화하고, 녹화한 에피소드를 다시 보고 정리한다.

  /episode/cmd    ← {"op": "start", "id", "task", "meta": {...}} | {"op": "stop", "id", "result"}
                    {"op": "play" | "stop_play", "name"}   재생: 녹화한 토픽을 /replay/<토픽> 으로 (실제 로봇·트윈과 섞이지 않게)
                    {"op": "label", "name", "result": "success" | "fail"}   결과 고치기 (학습 변환은 success만 씀)
                    {"op": "delete" | "restore", "name"}   지우기 = <data_dir>/.trash 로 옮김 (되돌리기 가능, 앱은 영구 삭제하지 않음)
  /episode/status → {"recording", "current", "playing": {name, duration} | null, "episodes": [최근 20개 요약], "ack", "error"}
  /workflow/vision ← AI 비전 판단 {"time", "node", "question", "answer", "confidence", "reason", "camera"} (녹화 중일 때만 저장)

저장 위치: <data_dir>/<YYYYmmdd-HHMMSS-mmm>_<작업>/
  bag/          rosbag2 (mcap). `ros2 bag info`, Foxglove, LeRobot 변환의 입력
  episode.json  작업 설명(지시문), 결과, 로봇, 토픽, 시각, 워크플로, vision(녹화 중 AI 비전 판단 라벨)
  record.log    ros2 bag record 출력
  play.log      ros2 bag play 출력 (다시 보기가 조용히 실패하지 않게)
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
SUMMARY = ('name', 'task', 'result', 'duration', 'started', 'topics', 'vision')
NAME = re.compile(r'[\w.-]+')  # 에피소드 폴더 이름 (경로 문자 금지)
REPLAY = '/replay'


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
        self.player = None  # ros2 bag play 프로세스
        self.playing = None
        self.pub = self.create_publisher(String, '/episode/status', LATCHED)
        self.create_subscription(String, '/episode/cmd', self.on_cmd, 10)
        self.create_subscription(String, '/workflow/vision', self.on_vision, 10)
        self.create_timer(1.0, self.watch)
        self.mark_interrupted()
        self.get_logger().info(f'녹화 위치 {self.data_dir}, 토픽 {self.topics}')
        self.publish()

    def publish(self, ack=None, error=''):
        data = {'recording': self.proc is not None, 'current': self.current, 'playing': self.playing,
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
            {'start': self.start, 'stop': self.stop, 'play': self.play, 'stop_play': self.stop_play,
             'label': self.label, 'delete': self.delete, 'restore': self.restore}[cmd['op']](cmd)
            self.publish(ack=cmd.get('id'))
        except Exception as e:  # noqa: BLE001 — 실패 이유를 요청자에게 돌려준다
            self.get_logger().error(f'{cmd.get("op")}: {e!r}')
            self.publish(ack=cmd.get('id'), error=str(e))

    def on_vision(self, msg):
        if not self.current:
            return
        try:
            label = json.loads(msg.data)
        except ValueError:
            return
        label['t'] = round(time.monotonic() - self.current['t0'], 3)  # 녹화 시작부터 초 (bag 시간축과 맞추기)
        self.current.setdefault('vision', []).append(label)
        self.write()

    def episode_dir(self, name, base=None):
        d = (base or self.data_dir) / str(name)
        if not NAME.fullmatch(str(name)) or not (d / 'episode.json').is_file():
            raise RuntimeError(f'에피소드 없음: {name}')
        return d

    def play(self, cmd):
        if self.proc:
            raise RuntimeError('녹화 중에는 재생할 수 없습니다')
        d = self.episode_dir(cmd.get('name'))
        e = json.loads((d / 'episode.json').read_text(encoding='utf-8'))
        self.stop_play()
        remaps = [f'{t}:={REPLAY}{t}' for t in e.get('topics', [])]
        with open(d / 'play.log', 'w', encoding='utf-8') as log:  # 재생이 조용히 실패하지 않게 출력을 남김 (녹화의 record.log와 같이)
            self.player = subprocess.Popen(
                # --delay: 새로 뜬 재생기를 구독자(웹의 rosbridge 등)가 찾을 시간을 줌. 없으면 짧은 녹화는 앞부분이나 전부를 놓침
                ['ros2', 'bag', 'play', str(d / 'bag'), '--disable-keyboard-controls', '--delay', '1', *(['--remap', *remaps] if remaps else [])],
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        self.playing = {'name': d.name, 'duration': e.get('duration')}

    def stop_play(self, cmd=None):
        if self.player and self.player.poll() is None:
            self.player.send_signal(signal.SIGINT)
            try:
                self.player.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.player.kill()
        self.player = self.playing = None

    def label(self, cmd):
        if cmd.get('result') not in ('success', 'fail'):
            raise RuntimeError('결과는 success 또는 fail')
        p = self.episode_dir(cmd.get('name')) / 'episode.json'
        e = json.loads(p.read_text(encoding='utf-8'))
        if 'ended' not in e:
            raise RuntimeError('녹화가 끝나지 않은 에피소드입니다')
        e.update(result=cmd['result'], relabeled=now_iso())
        p.write_text(json.dumps(e, ensure_ascii=False, indent=2), encoding='utf-8')

    def delete(self, cmd):
        d = self.episode_dir(cmd.get('name'))
        if self.current and self.current['name'] == d.name:
            raise RuntimeError('녹화 중인 에피소드는 지울 수 없습니다')
        if self.playing and self.playing['name'] == d.name:
            self.stop_play()
        trash = self.data_dir / '.trash'
        trash.mkdir(exist_ok=True)
        d.rename(trash / d.name)

    def restore(self, cmd):
        d = self.episode_dir(cmd.get('name'), self.data_dir / '.trash')
        if (self.data_dir / d.name).exists():
            raise RuntimeError(f'같은 이름이 이미 있습니다: {d.name}')
        d.rename(self.data_dir / d.name)

    def start(self, cmd):
        if self.proc:
            raise RuntimeError(f'이미 녹화 중: {self.current["name"]}')
        self.stop_play()  # 재생 중이던 /replay 토픽이 녹화에 섞이지 않게
        task = cmd.get('task', '')
        slug = re.sub(r'[^\w-]+', '_', task).strip('_')[:40]
        name = datetime.now().strftime('%Y%m%d-%H%M%S-%f')[:-3] + (f'_{slug}' if slug else '')
        d = self.data_dir / name
        d.mkdir(parents=True)
        self.current = {'id': cmd.get('id'), 'name': name, 'task': task, 'robot': self.robot,
                        'topics': self.topics, 'started': now_iso(), **cmd.get('meta', {}),
                        't0': time.monotonic()}  # 경과 시간은 단조 시계로 (벽시계는 시간 동기화로 뒤로 갈 수 있음 → 음수 길이·시각)
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
        """녹화기가 지금 발행 중인 대상 토픽을 실제로 구독할 때까지 기다린다. 그 전의 동작은 녹화되지 않기 때문.
        구독자만 있는 토픽(예: 아직 판단이 없는 /workflow/vision)은 rosbag2가 발행자가 생길 때 구독하므로 기다리지 않는다."""
        existing = {t for t, _ in self.get_topic_names_and_types() if t in self.topics and self.count_publishers(t) > 0}
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
        c.update(result=result, ended=now_iso(), duration=round(time.monotonic() - c.pop('t0'), 3))
        self.write()
        self.proc = self.current = None

    def write(self):
        path = self.data_dir / self.current['name'] / 'episode.json'
        path.write_text(json.dumps(self.current, ensure_ascii=False, indent=2), encoding='utf-8')

    def watch(self):
        if self.player and self.player.poll() is not None:  # 재생이 끝남
            self.player = self.playing = None
            self.publish()
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
        node.stop_play()


if __name__ == '__main__':
    main()
