# 낱말 크로스워드 — Fly.io 배포용 이미지
# node:sqlite(내장 SQLite)를 쓰므로 Node 22 이상이 필요하다.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    CROSSWORD_DATA=/data \
    TRUST_PROXY=fly

# 외부 패키지가 없어 npm install 이 필요 없다
COPY package.json server.js db.js index.html ./
COPY css ./css
COPY js ./js

EXPOSE 8080
CMD ["node", "server.js"]
