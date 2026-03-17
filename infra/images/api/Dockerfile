FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json

RUN npm ci --workspace backend --workspace shared --omit=dev

COPY backend backend
COPY shared shared

ENV NODE_ENV=production
ENV PORT=5174

EXPOSE 5174

CMD ["npm", "run", "start", "--workspace", "backend"]
