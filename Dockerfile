FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/app/data/eventreg.db

VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "src/app.js"]
