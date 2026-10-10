"""AI 시나리오 생성기: 작업 설명(자연어)을 받아, 지금 서버에 있는 노드 타입만으로 워크플로를 만든다.

  /workflow/generate/cmd ← {"id", "prompt"}
  /workflow/generate     → {"ack", "busy", "graph", "summary", "warnings", "error"}   (latched)

결과는 scenario.validate()로 검사한 뒤 보낸다. 웹은 바로 실행하지 않고 편집기로 불러와 사람이 확인한다.
"""
import json
import threading

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import String

import scenario

LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)


class ScenarioAI(Node):
    def __init__(self):
        super().__init__('scenario_ai')
        self.specs, self.joints, self.busy = [], [], None
        self.create_subscription(String, '/workflow/node_types', lambda m: setattr(self, 'specs', json.loads(m.data)), LATCHED)
        self.create_subscription(String, '/workflow/status', self.on_status, LATCHED)
        self.pub = self.create_publisher(String, '/workflow/generate', LATCHED)
        self.create_subscription(String, '/workflow/generate/cmd', self.on_cmd, 10)
        self.publish()

    def on_status(self, m):
        self.joints = json.loads(m.data).get('joints') or self.joints

    def publish(self, **kw):
        self.pub.publish(String(data=json.dumps({'busy': self.busy, **kw}, ensure_ascii=False)))

    def on_cmd(self, msg):
        try:
            cmd = json.loads(msg.data)
        except ValueError:
            return
        if self.busy:
            self.publish(ack=cmd.get('id'), error='이미 다른 시나리오를 만드는 중입니다')
            return
        if not self.specs:
            self.publish(ack=cmd.get('id'), error='실행기에서 노드 목록을 아직 받지 못했습니다')
            return
        self.busy = cmd.get('id')
        self.publish()
        threading.Thread(target=self.generate, args=(cmd,), daemon=True).start()  # AI 응답은 수십 초 걸릴 수 있음

    def generate(self, cmd):
        result = {}
        try:
            import ai_client
            prompt = f'{scenario.describe(self.specs, self.joints)}\n\n작업 설명:\n{cmd["prompt"]}'
            raw = ai_client.ask_json([{'type': 'text', 'text': prompt}], scenario.SCHEMA, scenario.SYSTEM,
                                     effort='high', max_tokens=16000)
            graph, warnings = scenario.validate(raw, self.specs, len(self.joints))
            result = {'graph': graph, 'summary': raw['summary'], 'warnings': warnings}
            self.get_logger().info(f'시나리오 생성: 노드 {len(graph["nodes"])}개, 경고 {len(warnings)}개')
        except ImportError:
            result = {'error': 'AI 패키지(anthropic)가 설치되지 않음: ros 이미지를 다시 빌드하세요'}
        except Exception as e:  # noqa: BLE001 — 실패 이유를 웹에 보여 준다
            self.get_logger().error(repr(e))
            result = {'error': str(e)}
        self.busy = None
        self.publish(ack=cmd.get('id'), **result)


def main():
    rclpy.init()
    try:
        rclpy.spin(ScenarioAI())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
