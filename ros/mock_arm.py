"""모의 6축 로봇팔.

실제 팔 드라이버(ros2_control joint_trajectory_controller)와 같은 인터페이스를 흉내낸다:
  joint_states                              → sensor_msgs/JointState (30Hz)
  arm_controller/follow_joint_trajectory    ← control_msgs/FollowJointTrajectory
(상대 이름이라 __ns:=/sim 으로 띄우면 /sim/joint_states 등 디지털 트윈용 팔이 된다.
 mirror_topic 을 주면 목표를 실행하지 않는 동안 그 토픽의 자세를 따라간다 → 시뮬레이션이 실제 자세에서 시작)
그래서 실행기·웹은 실제 팔로 바꿀 때 코드 변경 없이 액션 이름만 바꾸면 된다.
"""
import time

import rclpy
from control_msgs.action import FollowJointTrajectory
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import ExternalShutdownException, MultiThreadedExecutor
from rclpy.node import Node
from sensor_msgs.msg import JointState


class MockArm(Node):
    def __init__(self):
        super().__init__('mock_arm')
        self.names = self.declare_parameter('joints', [f'joint{i}' for i in range(1, 7)]).value
        self.pos = [0.0] * len(self.names)
        self.active = None
        self.pub = self.create_publisher(JointState, 'joint_states', 10)
        mirror = self.declare_parameter('mirror_topic', '').value
        if mirror:
            self.create_subscription(JointState, mirror, self.on_mirror, 10)
        self.create_timer(1 / 30, self.publish)
        ActionServer(
            self, FollowJointTrajectory, 'arm_controller/follow_joint_trajectory', self.execute,
            goal_callback=lambda req: GoalResponse.ACCEPT
            if set(req.trajectory.joint_names) == set(self.names) else GoalResponse.REJECT,
            cancel_callback=lambda _: CancelResponse.ACCEPT,
            callback_group=ReentrantCallbackGroup())

    def publish(self):
        msg = JointState(name=self.names, position=list(self.pos))
        msg.header.stamp = self.get_clock().now().to_msg()
        self.pub.publish(msg)

    def on_mirror(self, m):
        if self.active is None:
            pos = dict(zip(m.name, m.position))
            self.pos = [pos.get(n, p) for n, p in zip(self.names, self.pos)]

    def execute(self, goal):
        try:
            return self.follow(goal)
        finally:
            if self.active is goal:
                self.active = None

    def follow(self, goal):
        # ponytail: 점 사이 smoothstep 보간만 함. 속도/가속도 제한, 충돌은 무시 (실제 팔이 처리)
        self.active = goal  # 새 목표가 오면 이전 목표는 아래 루프에서 중단 (실제 컨트롤러와 같은 선점 동작)
        traj = goal.request.trajectory
        idx = [traj.joint_names.index(n) for n in self.names]
        t0, prev_t = time.monotonic(), 0.0
        for pt in traj.points:
            start, target = list(self.pos), [pt.positions[i] for i in idx]
            t_end = pt.time_from_start.sec + pt.time_from_start.nanosec * 1e-9
            a = 0.0
            while a < 1.0:
                if goal.is_cancel_requested:
                    goal.canceled()
                    return FollowJointTrajectory.Result()
                if self.active is not goal:
                    goal.abort()
                    return FollowJointTrajectory.Result(error_string='preempted')
                a = 1.0 if t_end <= prev_t else min(1.0, (time.monotonic() - t0 - prev_t) / (t_end - prev_t))
                s = a * a * (3 - 2 * a)
                self.pos = [p + (q - p) * s for p, q in zip(start, target)]
                time.sleep(0.01)
            prev_t = t_end
        goal.succeed()
        return FollowJointTrajectory.Result()


def main():
    rclpy.init()
    try:
        rclpy.spin(MockArm(), executor=MultiThreadedExecutor())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
