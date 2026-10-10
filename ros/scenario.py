"""AI 시나리오 생성의 순수 로직 (ROS 없이 테스트 가능): 프롬프트 구성, 응답 스키마, 결과 검증.

AI가 만든 그래프를 그대로 믿지 않는다. validate()가 실행기 형식으로 바꾸면서
없는 노드 타입·포트, 끊긴 연결은 거절하고, 관절 수·선택지 같은 값 문제는 고친 뒤 경고로 알린다.
"""

SYSTEM = """당신은 산업용 로봇 작업 셀의 공정 설계자입니다. 현장 작업자가 말로 설명한 작업을, 아래 '사용 가능한 노드'만 써서 워크플로 그래프로 만듭니다.

그래프 규칙:
- 노드 id는 짧은 영문 소문자와 밑줄. 시작 노드는 정확히 하나이며 id "start", type "start".
- 실행은 노드의 출력 포트를 따라 진행합니다. 엣지의 port는 출발 노드의 출력 id이고, 출력이 하나뿐인 노드는 빈 문자열입니다.
- 동시에 할 일은 같은 포트에서 여러 노드로 연결하고, 다시 모일 때는 join 노드로 모읍니다.
- 반복은 loop 노드: repeat 포트 → 반복할 단계들 → 그 마지막 단계에서 loop 노드로 되돌아오는 엣지, done 포트 → 반복 후 단계.
- 카메라로 눈에 보이는 상태를 판단해야 하면 vlm_check(질문은 예/아니오로 답할 수 있게), 센서 신호(토픽 값)면 if를 씁니다.
- fields의 value는 문자열입니다. joints 종류는 관절 수만큼 쉼표로 구분한 각도(°)이며, 정확한 자세를 모르면 0으로 두고 summary에 '자세 티칭 필요'라고 적습니다.
- 사용자가 말하지 않은 장비·센서·토픽을 지어내지 않습니다. 꼭 필요한데 정보가 없으면 합리적인 기본값을 쓰고 summary에 가정으로 밝힙니다.
- 필요한 노드만 씁니다.

summary: 만든 시나리오를 현장 작업자가 이해하도록 한국어 3~5문장으로 설명하고, 가정과 사람이 확인할 점을 포함합니다."""

SCHEMA = {
    'type': 'object',
    'properties': {
        'summary': {'type': 'string'},
        'nodes': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {
                'id': {'type': 'string'},
                'type': {'type': 'string'},
                'fields': {'type': 'array', 'items': {
                    'type': 'object',
                    'properties': {'key': {'type': 'string'}, 'value': {'type': 'string'}},
                    'required': ['key', 'value'], 'additionalProperties': False,
                }},
            },
            'required': ['id', 'type', 'fields'], 'additionalProperties': False,
        }},
        'edges': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'source': {'type': 'string'}, 'target': {'type': 'string'}, 'port': {'type': 'string'}},
            'required': ['source', 'target', 'port'], 'additionalProperties': False,
        }},
    },
    'required': ['summary', 'nodes', 'edges'],
    'additionalProperties': False,
}

START = {'type': 'start', 'label': '시작', 'fields': [], 'outputs': [{'id': 'out', 'label': ''}]}


def describe(specs, joints):
    """실행기가 알려준 노드 타입을 프롬프트용 목록으로 (고급 노드 포함, 표시만 다름)."""
    lines = [f'로봇 관절 {len(joints)}개: {", ".join(joints)}', '', '사용 가능한 노드:',
             '- start (시작): 필드 없음, 출력 out']
    for s in specs:
        fields = []
        for f in s['fields']:
            extra = f' 선택지={"/".join(f["options"])}' if f.get('options') else ''
            fields.append(f'{f["key"]}({f["kind"]}{extra}, 기본값={f["default"]!r}): {f["label"]}')
        outs = ', '.join(f'{o["id"]}' + (f'({o["label"]})' if o['label'] else '') for o in s['outputs'])
        desc = f' — {s["desc"]}' if s.get('desc') else ''
        lines.append(f'- {s["type"]} ({s["label"]}, 분류: {s["group"]}{", 고급" if s.get("advanced") else ""}){desc}'
                     f'\n    필드: {"; ".join(fields) or "없음"}\n    출력: {outs}')
    return '\n'.join(lines)


def _joints(value, n, warnings, node_id):
    parts = [p.strip() for p in str(value).replace('°', '').split(',') if p.strip()] if value not in (None, '') else []
    vals = []
    for p in parts:
        try:
            vals.append(float(p))
        except ValueError:
            vals.append(0.0)
            warnings.append(f'{node_id}: 관절 값 "{p}"을(를) 숫자로 읽을 수 없어 0으로 둠')
    if len(vals) != n:
        if parts:
            warnings.append(f'{node_id}: 관절 값 {len(vals)}개를 {n}개로 맞춤 (자세 확인 필요)')
        vals = (vals + [0.0] * n)[:n]
    return [int(v) if v == int(v) else v for v in vals]


def validate(raw, specs, n_joints):
    """AI 응답 → 실행기 그래프 {nodes, edges}. 구조 오류는 ValueError, 값 문제는 고치고 warnings에 남긴다."""
    by_type = {s['type']: s for s in specs}
    warnings, nodes, ids = [], [], {}
    for n in raw['nodes']:
        nid, t = n['id'], n['type']
        if t != 'start' and t not in by_type:
            raise ValueError(f'이 서버에 없는 노드 타입을 사용함: {t}')
        if nid in ids:
            raise ValueError(f'노드 id 중복: {nid}')
        spec = START if t == 'start' else by_type[t]
        ids[nid] = spec
        given = {f['key']: f['value'] for f in n.get('fields', [])}
        known = {f['key'] for f in spec['fields']}
        for k in sorted(set(given) - known):
            warnings.append(f'{nid}: 알 수 없는 항목 "{k}" 무시')
        data = {}
        for f in spec['fields']:
            v = given.get(f['key'], f['default'])
            if f['kind'] == 'joints':
                v = _joints(v, n_joints, warnings, nid)
            elif f['kind'] == 'select' and v not in f['options']:
                warnings.append(f'{nid}: "{f["label"]}" 값 "{v}"은(는) 선택지에 없어 기본값 "{f["default"]}"로 바꿈')
                v = f['default']
            data[f['key']] = v
        nodes.append({'id': nid, 'type': t, 'data': data})
    if sum(n['type'] == 'start' for n in nodes) != 1:
        raise ValueError('시작 노드가 정확히 하나가 아님')

    edges, seen = [], set()
    for e in raw['edges']:
        s, t = e['source'], e['target']
        if s not in ids or t not in ids:
            raise ValueError(f'없는 노드를 잇는 연결: {s} → {t}')
        outs = [o['id'] for o in ids[s]['outputs']]
        port = e.get('port') or outs[0]
        if port not in outs:
            raise ValueError(f'{s} 노드에 없는 출력 "{port}" (가능: {", ".join(outs)})')
        if (s, port, t) in seen:
            continue
        seen.add((s, port, t))
        edges.append({'id': f'{s}-{port}-{t}', 'source': s, 'target': t, **({'sourceHandle': port} if port != outs[0] or len(outs) > 1 else {})})

    start = next(n['id'] for n in nodes if n['type'] == 'start')
    reach, stack = {start}, [start]
    while stack:
        cur = stack.pop()
        for e in edges:
            if e['source'] == cur and e['target'] not in reach:
                reach.add(e['target'])
                stack.append(e['target'])
    for n in nodes:
        if n['id'] not in reach:
            warnings.append(f'{n["id"]}: 시작에서 이어지지 않아 실행되지 않음')
    return {'nodes': nodes, 'edges': edges}, warnings
