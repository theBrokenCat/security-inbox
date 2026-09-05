FROM node:24-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
COPY views ./views
COPY public ./public
COPY Dockerfile ./Dockerfile
COPY compose.yaml ./compose.yaml
COPY README.md ./README.md
COPY AGENTS.md ./AGENTS.md
COPY tasks/lessons.md ./tasks/lessons.md
COPY scripts/verify-demo.sh ./scripts/verify-demo.sh
RUN npm run build

RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production
USER node

CMD ["npm", "run", "web"]
