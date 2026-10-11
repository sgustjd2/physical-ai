FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# 시작할 때 비밀번호·/ros 중계 설정을 만든다 (nginx-entrypoint.sh). 호스트 네트워크로 8080에서 받음 (docker-compose.yml)
COPY nginx-entrypoint.sh /docker-entrypoint.d/40-physical-ai.sh
RUN chmod +x /docker-entrypoint.d/40-physical-ai.sh
EXPOSE 8080
