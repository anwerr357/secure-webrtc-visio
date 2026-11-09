FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public
# Run as the unprivileged "node" user, not root.
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
