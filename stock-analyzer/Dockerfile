# Signal Lab — zero runtime dependencies, runs as the unprivileged "node" user.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server.js"]
