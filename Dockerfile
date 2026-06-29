# Nailed It — voice demo proxy. Runs the TS proxy directly via tsx.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching. tsx/typescript are devDependencies but the
# `start` script runs the TS source through tsx, so we need the full install.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# App source
COPY . .

# Fly routes to this port; the server reads PORT from the env.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
