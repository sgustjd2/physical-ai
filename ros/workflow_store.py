"""워크플로 저장소: 웹에서 만든 워크플로를 GB10에 이름 붙여 저장한다 (누가 접속하든 같은 워크플로를 쓰도록).

  /workflow/library/cmd ← {"op": "save", "id", "name", "graph"} | {"op": "delete", "id", "name"}
  /workflow/library     → {"items": [{name, updated, graph}], "ack": 처리한 cmd id, "error"}   (latched)

저장 위치: <data_dir>/<이름>.json  ({name, updated, graph}) — 파일을 직접 복사해 다른 GB10으로 옮겨도 된다.
"""
import json
import re
from datetime import datetime
from pathlib import Path

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import String

LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)


def file_name(name):
    safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '_', name).strip(' .')[:80]
    if not safe:
        raise ValueError('워크플로 이름이 비어 있음')
    return f'{safe}.json'


class Store(Node):
    def __init__(self):
        super().__init__('workflow_store')
        default_dir = Path(__file__).resolve().parent.parent / 'data' / 'workflows'
        self.dir = Path(self.declare_parameter('data_dir', str(default_dir)).value)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.pub = self.create_publisher(String, '/workflow/library', LATCHED)
        self.create_subscription(String, '/workflow/library/cmd', self.on_cmd, 10)
        self.get_logger().info(f'워크플로 저장 위치 {self.dir}')
        self.publish()

    def items(self):
        out = []
        for p in sorted(self.dir.glob('*.json')):
            try:
                out.append(json.loads(p.read_text(encoding='utf-8')))
            except (OSError, ValueError):
                self.get_logger().warn(f'읽을 수 없는 워크플로 파일: {p.name}')
        return sorted(out, key=lambda w: w.get('updated', ''), reverse=True)

    def publish(self, ack=None, error=''):
        data = {'items': self.items(), 'ack': ack, 'error': error}
        self.pub.publish(String(data=json.dumps(data, ensure_ascii=False)))

    def on_cmd(self, msg):
        cmd = {}
        try:
            cmd = json.loads(msg.data)
            path = self.dir / file_name(cmd.get('name', ''))
            if cmd['op'] == 'save':
                g = cmd['graph']
                if not isinstance(g.get('nodes'), list) or not isinstance(g.get('edges'), list):
                    raise ValueError('graph에 nodes/edges 배열이 없음')
                item = {'name': cmd['name'], 'updated': datetime.now().astimezone().isoformat(timespec='seconds'), 'graph': g}
                path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding='utf-8')
            elif cmd['op'] == 'delete':
                path.unlink(missing_ok=True)
            else:
                raise ValueError(f'알 수 없는 op: {cmd["op"]}')
            self.publish(ack=cmd.get('id'))
        except Exception as e:  # noqa: BLE001 — 실패 이유를 요청자에게 돌려준다
            self.get_logger().error(f'{cmd.get("op")}: {e!r}')
            self.publish(ack=cmd.get('id'), error=str(e))


def main():
    rclpy.init()
    try:
        rclpy.spin(Store())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
