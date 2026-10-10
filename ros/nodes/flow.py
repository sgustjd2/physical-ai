"""흐름 제어 노드."""
from nodes import field, node


@node('wait', '대기', fields=[field('sec', '시간 (s)', 'number', 1)])
def wait(ctx, d):
    ctx.sleep(float(d['sec']))
