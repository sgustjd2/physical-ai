#!/bin/sh
# 웹(nginx) 설정을 시작할 때 만든다 (공식 nginx 이미지가 /docker-entrypoint.d/ 의 스크립트를 먼저 실행).
#  - 페이지·로봇 파일: 아이디/비밀번호(HTTP Basic). 통과하면 세션 쿠키를 준다
#  - /ros: rosbridge(127.0.0.1:9090) 웹소켓 중계. 세션 쿠키가 있어야 열림
#    (웹소켓에 Basic 인증 헤더를 안 붙이는 브라우저가 있어 쿠키로 확인 — 쿠키는 모든 브라우저가 붙임)
#  - WEB_ALLOW 가 있으면 그 주소(대역)에서만 접속
# 환경변수 (docker-compose.yml → .env): WEB_USER(기본 operator), WEB_PASSWORD, WEB_ALLOW("192.168.10.0/24 10.0.0.5")
set -eu

user="${WEB_USER:-operator}"
pw="${WEB_PASSWORD:-}"
saved=/data/web-password
if [ -z "$pw" ]; then
  # 비밀번호를 정하지 않았으면 처음 한 번 만들어 보관 (열린 채로 시작하지 않게). .env 의 WEB_PASSWORD 로 바꿀 수 있음
  [ -s "$saved" ] || (umask 077 && head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12 > "$saved")
  pw="$(cat "$saved")"
  echo "[physical-ai] 웹 접속: 아이디 ${user} / 비밀번호 ${pw} (자동 생성, GB10의 data/web/web-password — .env 의 WEB_PASSWORD 로 바꿀 수 있음)"
fi
case "$pw$user" in *[[:space:]:]*) echo "[physical-ai] WEB_USER·WEB_PASSWORD 에는 공백과 ':' 을 쓸 수 없습니다" >&2; exit 1 ;; esac

# 세션 쿠키 값 = 비밀번호에서 만든 값 (비밀번호를 바꾸면 기존 쿠키는 무효)
session="$(printf '%s' "physical-ai:${user}:${pw}" | sha256sum | cut -c1-40)"
printf '%s:{PLAIN}%s\n' "$user" "$pw" > /etc/nginx/.htpasswd
chown root:nginx /etc/nginx/.htpasswd && chmod 640 /etc/nginx/.htpasswd  # nginx 작업 프로세스만 읽음

allow=""
for a in $(echo "${WEB_ALLOW:-}" | tr ',' ' '); do
  case "$a" in *[!0-9A-Fa-f.:/]*) echo "[physical-ai] WEB_ALLOW 에는 IP·대역만 씁니다 (예: 192.168.10.0/24): $a" >&2; exit 1 ;; esac
  allow="${allow}    allow ${a};
"; done
[ -n "$allow" ] && allow="${allow}    deny all;
"

cat > /etc/nginx/conf.d/default.conf <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
    listen 8080;
${allow}    root /usr/share/nginx/html;

    location / {
        auth_basic "Physical AI";
        auth_basic_user_file /etc/nginx/.htpasswd;
        # always 를 붙이면 401(비밀번호 틀림)에도 쿠키가 나감 → 성공 응답에만
        add_header Set-Cookie "pa_session=${session}; Path=/; HttpOnly; SameSite=Strict";
        try_files \$uri \$uri/ /index.html;
    }
    # URDF 메시·작업 셀 파일: 없는 파일은 404 (앱 페이지를 돌려주면 3D 로더가 HTML을 메시로 읽음)
    location /robots/ {
        auth_basic "Physical AI";
        auth_basic_user_file /etc/nginx/.htpasswd;
        try_files \$uri =404;
    }
    location = /ros {
        if (\$cookie_pa_session != "${session}") { return 403; }
        proxy_pass http://127.0.0.1:9090/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
    }
}
EOF
