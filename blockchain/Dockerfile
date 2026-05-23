FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json hardhat.config.ts ./
COPY src/ ./src/

# 컨트랙트 컴파일 — artifacts/ 이미지에 포함
RUN npm run compile

EXPOSE 8545

# --hostname 0.0.0.0: 컨테이너 외부(호스트/다른 컨테이너)에서 접근 가능
CMD ["npm", "run", "node"]
