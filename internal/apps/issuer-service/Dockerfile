# build context: 모노레포 루트 (docker-compose.yml 참고)
FROM node:20-alpine
WORKDIR /app

# ── 의존성 레이어 (소스 변경 시 캐시 재사용) ─────────────────────────────────
COPY package*.json ./
COPY internal/packages/chain-adapters/package.json ./internal/packages/chain-adapters/
COPY internal/packages/vasp/package.json            ./internal/packages/vasp/
COPY internal/packages/core-banking/package.json    ./internal/packages/core-banking/
COPY internal/packages/event-engine/package.json    ./internal/packages/event-engine/
COPY internal/packages/compliance/package.json      ./internal/packages/compliance/
COPY internal/packages/shared/package.json          ./internal/packages/shared/
COPY internal/apps/issuer-service/package.json      ./internal/apps/issuer-service/

RUN npm ci

# ── 소스 복사 ────────────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY internal/packages ./internal/packages
COPY internal/apps/issuer-service ./internal/apps/issuer-service

EXPOSE 3000

# npm workspace 심볼릭 링크로 @kyobo/* 패키지 해소 → ts-node로 직접 실행
CMD ["npx", "ts-node", \
     "--project", "internal/apps/issuer-service/tsconfig.json", \
     "internal/apps/issuer-service/src/index.ts"]
