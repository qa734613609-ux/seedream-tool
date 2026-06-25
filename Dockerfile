FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.html server.js manifest.webmanifest sw.js icon.svg ./
RUN mkdir -p uploads data

EXPOSE 3000

CMD ["node", "server.js"]
